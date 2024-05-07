import { Protocol } from '@uniswap/router-sdk'
import { setGlobalLogger, setGlobalMetric } from '@uniswap/smart-order-router'
import { EventBridgeEvent, ScheduledHandler } from 'aws-lambda'
import { S3 } from 'aws-sdk'
import { ChainId } from '@uniswap/sdk-core'
import { default as bunyan, default as Logger } from 'bunyan'
import { S3_POOL_CACHE_KEY } from '../util/pool-cache-key'
import { chainProtocols } from './cache-config'
import { AWSMetricsLogger } from '../handlers/router-entities/aws-metrics-logger'
import { metricScope } from 'aws-embedded-metrics'
import * as zlib from 'zlib'

const handler: ScheduledHandler = metricScope((metrics) => async (event: EventBridgeEvent<string, void>) => {
  const beforeAll = Date.now()
  metrics.setNamespace('Uniswap')
  metrics.setDimensions({ Service: 'CachePools' })
  const metric = new AWSMetricsLogger(metrics)
  setGlobalMetric(metric)

  const chainId: ChainId = parseInt(process.env.chainId!)
  const protocol = process.env.protocol! as Protocol
  // Don't retry for V2 as it will timeout and throw 500
  const provider = chainProtocols.find(
    (element) => element.protocol == protocol && element.chainId == chainId
  )!.provider
  const log: Logger = bunyan.createLogger({
    name: 'RoutingLambda',
    serializers: bunyan.stdSerializers,
    level: 'info',
    requestId: event.id,
  })
  setGlobalLogger(log)

  const s3 = new S3()

  log.info(`Getting pools for ${protocol} on ${chainId}`)
  const metricPrefix = `CachePools.chain_${chainId}.${protocol}_protocol`
  metric.putMetric(metricPrefix, 1)

  let pools
  try {
    const beforeGetPool = Date.now()
    pools = await provider.getPools()
    metric.putMetric(`${metricPrefix}.getPools.latency`, Date.now() - beforeGetPool)
  } catch (err) {
    metric.putMetric(`${metricPrefix}.getPools.error`, 1)
    log.error({ err }, `Failed to get pools for ${protocol} on ${chainId}`)
    throw new Error(`Failed to get pools for ${protocol} on ${chainId}`)
  }

  if (!pools || pools.length == 0) {
    metric.putMetric(`${metricPrefix}.getPools.empty`, 1)
    log.info(`No ${protocol} pools found from the subgraph for ${chainId.toString()}`)
    return
  }

  const beforeS3 = Date.now()
  const key = S3_POOL_CACHE_KEY(process.env.POOL_CACHE_KEY!, chainId, protocol)

  log.info(`Got ${pools.length} ${protocol} pools from the subgraph for ${chainId.toString()}. Saving to ${key}`)
  const compressedPools = zlib.deflateSync(JSON.stringify(pools))
  log.info(`compressed pools to decompress ${zlib.inflateSync(compressedPools).length}`)

  const result = await Promise.all([s3
    .putObject({
      Bucket: process.env.POOL_CACHE_BUCKET_2!,
      Key: key,
      Body: JSON.stringify(pools),
    })
    .promise(),
    s3
      .putObject({
        Bucket: process.env.POOL_CACHE_BUCKET_3!,
        Key: key,
        Body: compressedPools,
      })
      .promise()
  ]);

  metric.putMetric(`${metricPrefix}.s3.latency`, Date.now() - beforeS3)

  log.info({ result }, `Done ${protocol} for ${chainId.toString()}`)

  log.info(`Successfully cached ${chainId} ${protocol} pools to S3`)
  metric.putMetric(`${metricPrefix}.latency`, Date.now() - beforeAll)
})

module.exports = { handler }
