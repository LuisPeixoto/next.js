import { nextTestSetup } from 'e2e-utils'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { findPort } from 'next-test-utils'

const unresolvedImage =
  'https://image-optimizer-upstream-errors.invalid/image.jpg'
const upstreamError = '"url" parameter is valid but upstream request failed'

// Deployments use an image CDN rather than the self-hosted image optimizer.
// @force-gate !deploy
describe('image-optimizer-upstream-errors', () => {
  for (const dangerouslyAllowLocalIP of [false, true]) {
    describe(`dangerouslyAllowLocalIP: ${dangerouslyAllowLocalIP}`, () => {
      const { next } = nextTestSetup({
        files: __dirname,
        nextConfig: {
          images: {
            dangerouslyAllowLocalIP,
            remotePatterns: [
              { hostname: 'image-optimizer-upstream-errors.invalid' },
              { hostname: '127.0.0.1' },
            ],
          },
        },
      })

      function fetchImage(url: string) {
        const query = new URLSearchParams({ url, w: '640', q: '75' })
        return next.fetch(`/_next/image?${query}`)
      }

      it('returns 502 when the upstream hostname cannot be resolved', async () => {
        const res = await fetchImage(unresolvedImage)
        expect(res.status).toBe(502)
        expect(await res.text()).toBe(upstreamError)
      })

      if (!dangerouslyAllowLocalIP) {
        it('still rejects private IP addresses with 400', async () => {
          const res = await fetchImage('http://127.0.0.1/image.jpg')
          expect(res.status).toBe(400)
          expect(await res.text()).toBe('"url" parameter is not allowed')
        })
      } else {
        let server: Server
        let origin: string

        beforeAll(async () => {
          server = createServer((req, res) => {
            if (req.url === '/redirect') {
              res.writeHead(302, { location: unresolvedImage })
            } else if (req.url === '/reset') {
              req.socket.destroy()
              return
            } else {
              res.writeHead(404)
            }
            res.end()
          })
          await new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', resolve)
          })
          origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        })

        afterAll(async () => {
          if (server) {
            server.closeAllConnections()
            await new Promise<void>((resolve) => server.close(() => resolve()))
          }
        })

        it('returns 502 when the upstream refuses the connection', async () => {
          const port = await findPort()
          const res = await fetchImage(`http://127.0.0.1:${port}/image.jpg`)
          expect(res.status).toBe(502)
          expect(await res.text()).toBe(upstreamError)
        })

        it('returns 502 when the upstream resets the connection', async () => {
          const res = await fetchImage(`${origin}/reset`)
          expect(res.status).toBe(502)
          expect(await res.text()).toBe(upstreamError)
        })

        it('returns 502 when the TLS handshake fails', async () => {
          const res = await fetchImage(
            `${origin.replace('http:', 'https:')}/image.jpg`
          )
          expect(res.status).toBe(502)
          expect(await res.text()).toBe(upstreamError)
        })

        it('returns 502 when a redirect points to an unresolved hostname', async () => {
          const res = await fetchImage(`${origin}/redirect`)
          expect(res.status).toBe(502)
          expect(await res.text()).toBe(upstreamError)
        })

        it('preserves the status of an upstream HTTP error', async () => {
          const res = await fetchImage(`${origin}/missing.jpg`)
          expect(res.status).toBe(404)
          expect(await res.text()).toBe(
            '"url" parameter is valid but upstream response is invalid'
          )
        })
      }
    })
  }
})
