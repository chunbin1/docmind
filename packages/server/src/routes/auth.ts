// packages/server/src/routes/auth.ts
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { randomBytes } from 'node:crypto'
import {
  upsertGithubUser,
  getUserById,
  remaining,
  MESSAGE_LIMIT,
  type User,
} from '../services/userStore.js'

const CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? ''
const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? ''
// Base public URL of the app, e.g. https://docmind.cbsama.uk (no trailing slash).
const APP_URL = (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, '')
const CALLBACK_URL = `${APP_URL}/api/auth/github/callback`
const IS_HTTPS = APP_URL.startsWith('https://')
// Escape hatch for local dev without a GitHub OAuth app: every request is an
// unlimited synthetic user, so login is skipped entirely.
const AUTH_DISABLED = process.env.AUTH_DISABLED === 'true'

const COOKIE_UID = 'uid'
const COOKIE_STATE = 'oauth_state'

const DEV_USER: User = {
  id: 'dev',
  github_id: 0,
  username: 'dev',
  avatar_url: null,
  message_count: 0,
  unlimited: 1,
  is_admin: 1,
  created_at: '',
}

const baseCookie = {
  httpOnly: true as const,
  sameSite: 'lax' as const,
  secure: IS_HTTPS,
  path: '/',
}

/** Resolve the logged-in user from the signed `uid` cookie (or dev user). */
export function currentUser(request: FastifyRequest): User | null {
  if (AUTH_DISABLED) return DEV_USER
  const raw = request.cookies?.[COOKIE_UID]
  if (!raw) return null
  const unsigned = request.unsignCookie(raw)
  if (!unsigned.valid || !unsigned.value) return null
  return getUserById(unsigned.value)
}

function publicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    avatarUrl: user.avatar_url,
    messageCount: user.message_count,
    limit: MESSAGE_LIMIT,
    unlimited: user.unlimited === 1,
    isAdmin: user.is_admin === 1,
    remaining: remaining(user),
  }
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  // 1) Kick off GitHub OAuth
  app.get('/auth/github', async (_request, reply) => {
    if (AUTH_DISABLED) return reply.redirect(`${APP_URL}/`)
    if (!CLIENT_ID || !CLIENT_SECRET) {
      return reply.status(503).send({ error: 'GitHub OAuth not configured on the server' })
    }
    const state = randomBytes(16).toString('hex')
    reply.setCookie(COOKIE_STATE, state, { ...baseCookie, maxAge: 600 })

    const url = new URL('https://github.com/login/oauth/authorize')
    url.searchParams.set('client_id', CLIENT_ID)
    url.searchParams.set('redirect_uri', CALLBACK_URL)
    url.searchParams.set('scope', 'read:user')
    url.searchParams.set('state', state)
    return reply.redirect(url.toString())
  })

  // 2) GitHub redirects back here with ?code & ?state
  app.get<{ Querystring: { code?: string; state?: string } }>(
    '/auth/github/callback',
    async (request, reply) => {
      const { code, state } = request.query
      const expected = request.cookies?.[COOKIE_STATE]
      reply.clearCookie(COOKIE_STATE, { path: '/' })

      if (!code || !state || !expected || state !== expected) {
        return reply.status(400).send({ error: 'invalid_oauth_state' })
      }

      try {
        // Exchange the code for an access token
        const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code,
            redirect_uri: CALLBACK_URL,
          }),
        })
        const tokenJson = (await tokenRes.json()) as { access_token?: string }
        const accessToken = tokenJson.access_token
        if (!accessToken) throw new Error('no access_token from GitHub')

        // Fetch the GitHub profile
        const userRes = await fetch('https://api.github.com/user', {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': 'docmind',
            Accept: 'application/vnd.github+json',
          },
        })
        const profile = (await userRes.json()) as {
          id: number
          login: string
          avatar_url: string
        }
        if (!profile?.id) throw new Error('failed to load GitHub profile')

        const user = upsertGithubUser({
          githubId: profile.id,
          username: profile.login,
          avatarUrl: profile.avatar_url ?? null,
        })

        // Issue the session cookie (signed) and bounce back to the app
        reply.setCookie(COOKIE_UID, user.id, {
          ...baseCookie,
          signed: true,
          maxAge: 60 * 60 * 24 * 30, // 30 days
        })
        return reply.redirect(`${APP_URL}/`)
      } catch (err) {
        app.log.error(err)
        return reply.status(502).send({ error: 'github_oauth_failed' })
      }
    },
  )

  // 3) Current user (used by the frontend to gate the UI)
  app.get('/auth/me', async (request, reply) => {
    const user = currentUser(request)
    if (!user) return reply.status(401).send({ error: 'unauthorized' })
    return publicUser(user)
  })

  // 4) Logout
  app.post('/auth/logout', async (_request, reply) => {
    reply.clearCookie(COOKIE_UID, { path: '/' })
    return { ok: true }
  })
}
