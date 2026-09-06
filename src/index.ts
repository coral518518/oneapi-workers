import { Hono } from 'hono'
import { cors } from 'hono/cors';
import { api as providerApi } from './providers'
import { api as adminApi } from './admin'
import { fromHono } from 'chanfana';
import { syncNvidiaModels } from './cron/sync_nvidia';

const app = new Hono<HonoCustomType>()
const openapi = fromHono(app, {
  schema: {
    info: {
      title: 'New One API',
      version: '1.0.0',
    }
  },
  docs_url: '/api/docs',
  redoc_url: '/api/redocs',
  openapi_url: '/api/openapi.json'
});

// cors
openapi.use('/*', cors());
// global error handler
openapi.onError((err, c) => {
  console.error(err)
  return c.text(`${err.name} ${err.message}`, 500)
})

openapi.route('/', providerApi)
openapi.route('/', adminApi)

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: CloudflareBindings, ctx: ExecutionContext) {
    console.log(`[Scheduled] Cron triggered (${controller.cron}) at ${new Date().toISOString()}`);
    ctx.waitUntil(syncNvidiaModels(env));
  },
};

