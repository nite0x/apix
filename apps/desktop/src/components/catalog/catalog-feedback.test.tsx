import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CatalogFeedback } from './catalog-feedback'

describe('CatalogFeedback', () => {
  it('renders an actionable retry for Runtime errors', () => {
    const html = renderToStaticMarkup(
      <CatalogFeedback
        state="offline"
        error="Runtime unavailable"
        isPreview={false}
        blocking
        onRetry={vi.fn()}
      />,
    )

    expect(html).toContain('Runtime unavailable')
    expect(html).toContain('Retry')
  })

  it('labels fixture catalogs as preview data', () => {
    const html = renderToStaticMarkup(
      <CatalogFeedback
        state="ready"
        error={null}
        isPreview
        blocking={false}
        onRetry={vi.fn()}
      />,
    )

    expect(html).toContain('Preview catalog')
    expect(html).toContain('data is not saved')
  })
})
