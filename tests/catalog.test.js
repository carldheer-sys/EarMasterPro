/**
 * Catalog fetch guards — the dev/preview SPA fallback serves index.html
 * with HTTP 200 for missing /catalog/* paths, so a stale manifest used to
 * crash res.json() with "Unexpected token '<'" (and srcDoc'd the app into
 * the transcription sheet). StaleCatalogError drives the retry path.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  loadCatalog,
  loadSectionSession,
  invalidateCatalog,
  StaleCatalogError,
} from '../apps/web/src/lib/catalog.js'

const htmlResponse = () => new Response('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
  status: 200,
  headers: { 'content-type': 'text/html' },
})
const jsonResponse = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

afterEach(() => { vi.unstubAllGlobals(); invalidateCatalog() })

describe('catalog stale-asset guard', () => {
  it('session fetch throws StaleCatalogError when the SPA fallback returns HTML', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse()))
    const entry = { assets: { session: '/catalog/Old - Song/verse/session.eartrainer.json' } }
    await expect(loadSectionSession(entry)).rejects.toBeInstanceOf(StaleCatalogError)
  })

  it('session fetch resolves on real JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ notes: [], settings: {} })))
    const entry = { assets: { session: '/catalog/A - B/x/session.eartrainer.json' } }
    await expect(loadSectionSession(entry)).resolves.toEqual({ notes: [], settings: {} })
  })

  it('loadCatalog throws StaleCatalogError on HTML, invalidateCatalog allows a retry', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(htmlResponse())
      .mockResolvedValueOnce(jsonResponse({ artists: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(loadCatalog()).rejects.toBeInstanceOf(StaleCatalogError)
    // failing promise cleared itself — a retry hits fetch again
    await expect(loadCatalog()).resolves.toEqual({ artists: [] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('loadCatalog caches the manifest until invalidated', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ artists: [{ name: 'A' }] }))
    vi.stubGlobal('fetch', fetchMock)
    await loadCatalog()
    await loadCatalog()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    invalidateCatalog()
    await loadCatalog()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
