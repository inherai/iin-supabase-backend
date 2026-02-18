// supabase/functions/api/index.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { cors } from 'https://deno.land/x/hono/middleware.ts'
import { authMiddleware } from './middleware.ts' // <--- הייבוא החדש

// ייבוא הראוטים
import meRoute from './routes/me.ts'
import postsRoute from './routes/posts.ts'
import summaryRoute from './routes/summary.ts'
import searchAiRoute from './routes/search-ai.ts'
import jobsRoute from './routes/jobs.ts'
import profileRoute from './routes/profile.ts'
import likeRoute from './routes/like.ts'
import connectionsRoute from './routes/connections.ts'
import companiesRoute from './routes/companies.ts'
import chatRoute from './routes/chat.ts'
import interestsRoute from './routes/interests.ts'
import workPreferencesRoute from './routes/work-preferences.ts'
import languagesRoute from './routes/languages.ts'
import locationsRoute from './routes/locations.ts'
import educationalInstitutionsRoute from './routes/educational-institutions.ts'
import skillsRoute from './routes/skills.ts'
import activityRoute from './routes/activity.ts'

//const app = new Hono()
// מגדירים שהכל יושב תחת /api
const app = new Hono().basePath('/api')

// 1. לוג לכל בקשה (כדי שנראה ב-Dashboard מה נכנס)
app.use('*', async (c, next) => {
  console.log(`➡️ Incoming request: ${c.req.method} ${c.req.path}`);
  await next();
})

// 1. הגדרת CORS
app.use('/*', cors({
    origin: '*',
    allowHeaders: ['authorization', 'x-client-info', 'content-type'],
    allowMethods: ['POST', 'GET', 'OPTIONS', 'PUT', 'DELETE'],
    exposeHeaders: ['Content-Length', 'X-Kuma-Revision'],
    maxAge: 600,
    credentials: true,
}))

// 2. הפעלת ה-Middleware שיצרנו בנפרד
app.use('*', authMiddleware)

// 3. הגדרת הנתיבים
app.route('/me', meRoute)
app.route('/posts', postsRoute)
app.route('/summary', summaryRoute)
app.route('/search-ai', searchAiRoute)
app.route('/jobs', jobsRoute)
app.route('/profile', profileRoute)
app.route('/like', likeRoute)
app.route('/connections', connectionsRoute)
app.route('/companies', companiesRoute)
app.route('/chat', chatRoute)
app.route('/interests', interestsRoute)
app.route('/work-preferences', workPreferencesRoute)
app.route('/languages', languagesRoute)
app.route('/locations', locationsRoute)
app.route('/educational-institutions', educationalInstitutionsRoute)
app.route('/skills', skillsRoute)
app.route('/activity', activityRoute)
// בדיקה שהכל חי
app.get('/', (c) => c.text('Inerai API is running 🚀'))

Deno.serve(app.fetch)






