import { DynamoDB } from 'aws-sdk'
import { EventStore, GetByIdOptions } from './eventStore'
import { conflictError, notFoundError } from '../../model/errors'
import { validateEvents } from '../../model/eventSchema'
import { Event } from '../../model/eventTypes'
import { getSyncTime } from './getSyncTime'

const region = process.env.REGION
const esTable = process.env.EVENTSTORE_TABLE || 'eventstore'
// todo: use config
const SNAPSHOT_TABLE = 'getbyid-snapshots'
const MAX_EVENTS_UNTIL_SAVED = 10

const dynamoClient = new DynamoDB.DocumentClient({ region })

const emptyQueryRes = {
  Items: [],
  Count: 0,
  ScannedCount: 0
}

export const dynamoDbEventStore: EventStore = {
  getById: (id: string, options: GetByIdOptions = {}) => {
    if (!id) {
      throw new Error(`undefined "id" param in getById()`)
    }
    return queryRecursive(dynamoClient)({
      TableName: esTable,
      ConsistentRead: true,
      KeyConditionExpression: 'streamId = :a AND version >= :v',
      ExpressionAttributeValues: {
        ':a': id,
        ':v': options.version || 0
      }
    }).then(res => {
      if (res.Count === 0) {
        if (options.returnEmptyArrOn404) {
          return []
        }
        throw notFoundError({
          id,
          options,
          message: 'resource not found'
        })
      }
      return flat(res.Items.map(item => JSON.parse(item.events)))
    })
  },

  getByIdUsingSnapshot: ({ id, reducerId, reducerVersion, reducer }) => {
    return dynamoClient
      .query({
        TableName: SNAPSHOT_TABLE,
        KeyConditionExpression:
          'streamId = :streamId AND begins_with(snapshotId, :snapshotId)',
        ExpressionAttributeValues: {
          ':streamId': id,
          ':snapshotId': `${reducerId}:${reducerVersion}`
        }
      })
      .promise()
      .then(res => {
        if (res.Count === 1) {
          return {
            state: JSON.parse(res.Items[0].state),
            version: res.Items[0].version
          }
        }
        return {
          version: 0
        }
      })
      .then(snapshotState => {
        return dynamoDbEventStore
          .getById(id, {
            returnEmptyArrOn404: true,
            version: snapshotState.version ? snapshotState.version : undefined
          })
          .then(events => {
            return {
              state: reducer(events, snapshotState.state),
              version: snapshotState.version + events.length
            }
          })
          .then(currentState => {
            if (
              currentState.version - snapshotState.version >
              MAX_EVENTS_UNTIL_SAVED
            ) {
              // should update snapshot
              return dynamoClient
                .put({
                  TableName: SNAPSHOT_TABLE,
                  Item: {
                    streamId: id,
                    snapshotId: `${reducerId}:${reducerVersion}`,
                    version: currentState.version,
                    state: JSON.stringify(currentState.state)
                  },
                  ReturnValues: 'NONE'
                })
                .promise()
                .then(() => currentState)
            }
            // no need to update snapshot
            return currentState
          })
      })
  },

  getByIdAndVersion: (id: string, version: number) => {
    return queryRecursive(dynamoClient)({
      TableName: esTable,
      ConsistentRead: true,
      KeyConditionExpression: 'streamId = :a AND version = :v',
      ExpressionAttributeValues: {
        ':a': id,
        ':v': version
      }
    }).then(res => {
      if (res.Count === 0) {
        throw notFoundError({
          id,
          message: 'resource not found'
        })
      }
      return flat(res.Items.map(item => JSON.parse(item.events)))
    })
  },

  getByTimestamp: (timestamp: number) => {
    return dynamoClient
      .query({
        TableName: esTable,
        IndexName: 'active-committedAt-index',
        KeyConditionExpression:
          'active = :active and committedAt >= :timestamp',
        ExpressionAttributeValues: {
          ':active': 1,
          ':timestamp': timestamp
        }
      })
      .promise()
      .then(res => {
        if (res.LastEvaluatedKey) {
          console.log(
            `RESULT SET NOT COMPLETE! LastEvaluatedKey: ${
              res.LastEvaluatedKey
            } queried from ${timestamp}`
          )
        }
        return flat(
          res.Items.map(item =>
            JSON.parse(item.events).map(e => {
              return {
                ...e,
                committedAt: item.committedAt
              }
            })
          )
        )
      })
  },

  save: (params: {
    events: Event[]
    streamId: string
    expectedVersion: number
  }) => {
    return getSyncTime().then(syncTime => {
      const eventTimestamp =
        process.env.NODE_ENV === 'test' && global['testTimestamp']
          ? global['testTimestamp']
          : syncTime

      const eventsWithTimestamp = params.events.filter(e => !!e).map(e => ({
        ...e,
        timestamp: e.timestamp || eventTimestamp
      }))

      const error = validateEvents(eventsWithTimestamp)
      if (error) {
        console.log(JSON.stringify(eventsWithTimestamp))
        return Promise.reject(error)
      }

      return dynamoClient
        .put({
          TableName: esTable,
          Item: {
            commitId: syncTime + ':' + params.streamId,
            committedAt: syncTime,
            streamId: params.streamId,
            version: params.expectedVersion,
            active: 1,
            events: JSON.stringify(eventsWithTimestamp)
          },
          ConditionExpression: 'attribute_not_exists(version)',
          ReturnValues: 'NONE'
        })
        .promise()
        .then(() => {
          return {
            id: params.streamId
          }
        })
        .catch(err => {
          if (err.name === 'ConditionalCheckFailedException') {
            throw conflictError({
              ...params,
              message: 'A commit already exists with the specified version'
            })
          }

          throw err
        })
    })
  }
}

export const getDynamoEventStoreSchema = tableName => ({
  TableName: tableName,
  AttributeDefinitions: [
    { AttributeName: 'active', AttributeType: 'N' },
    { AttributeName: 'committedAt', AttributeType: 'N' },
    { AttributeName: 'streamId', AttributeType: 'S' },
    { AttributeName: 'version', AttributeType: 'N' }
  ],
  KeySchema: [
    { AttributeName: 'streamId', KeyType: 'HASH' },
    { AttributeName: 'version', KeyType: 'RANGE' }
  ],
  ProvisionedThroughput: {
    ReadCapacityUnits: 5,
    WriteCapacityUnits: 5
  },
  GlobalSecondaryIndexes: [
    {
      IndexName: 'active-committedAt-index',
      KeySchema: [
        { AttributeName: 'active', KeyType: 'HASH' },
        { AttributeName: 'committedAt', KeyType: 'RANGE' }
      ],
      Projection: { ProjectionType: 'ALL' },
      ProvisionedThroughput: {
        ReadCapacityUnits: 5,
        WriteCapacityUnits: 5
      }
    }
  ]
})

function flat(arr: any[]) {
  return arr.reduce((acc, val) => acc.concat(val), [])
}

const queryRecursive = dynamoClient => (
  params,
  allResults = emptyQueryRes
): Promise<any> =>
  dynamoClient
    .query(params)
    .promise()
    .then(res => {
      allResults = {
        ...allResults,
        Items: [...allResults.Items, ...res.Items],
        Count: allResults.Count + res.Count,
        ScannedCount: allResults.ScannedCount + res.ScannedCount
      }
      if (res.LastEvaluatedKey) {
        return queryRecursive(dynamoClient)(
          {
            ...params,
            ExclusiveStartKey: res.LastEvaluatedKey
          },
          allResults
        )
      }
      return allResults
    })
    .then(res => {
      return res as any
    })