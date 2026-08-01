import React, { FormEvent, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BookOpen, ExternalLink, FileText, Filter, KeyRound, Library, LoaderCircle, Search, Settings, Sparkles, X } from 'lucide-react'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import './styles.css'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

type SearchItem = { title: string; link: string; displayLink: string; snippet: string; thumbnail?: string; pages?: number; date?: string; size?: string; source?: string }
type Config = { key: string; cx: string }
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

function App() {
  const params = new URLSearchParams(location.search)
  const [query, setQuery] = useState(params.get('q') || '')
  const [items, setItems] = useState<SearchItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [config, setConfig] = useState<Config>(() => JSON.parse(localStorage.getItem('gargi-config') || '{"key":"","cx":""}'))
  const [site, setSite] = useState('')
  const [sort, setSort] = useState('relevance')
  const [searched, setSearched] = useState(false)
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null)

  const configured = Boolean(config.key && config.cx)
  const resultLabel = useMemo(() => items.length ? `${items.length} PDF${items.length === 1 ? '' : 's'} found` : '', [items])

  useEffect(() => { if (params.get('q')) void runSearch(params.get('q')!) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('./sw.js')
    const captureInstall = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPromptEvent) }
    window.addEventListener('beforeinstallprompt', captureInstall)
    return () => window.removeEventListener('beforeinstallprompt', captureInstall)
  }, [])

  async function runSearch(term: string) {
    if (!term.trim()) return
    setLoading(true); setError(''); setItems([]); setSearched(true)
    history.replaceState(null, '', `?q=${encodeURIComponent(term.trim())}`)
    try {
      const searches = [searchOpenAlex(term), searchInternetArchive(term)]
      if (configured) searches.unshift(searchGoogle(term))
      const batches = await Promise.allSettled(searches)
      const found = batches.flatMap(x => x.status === 'fulfilled' ? x.value : [])
        .filter((x, i, all) => all.findIndex(y => y.link === x.link) === i)
      if (!found.length && batches.every(x => x.status === 'rejected')) throw new Error('Search providers are temporarily unavailable. Try again shortly.')
      setItems(found)
      found.slice(0, 10).forEach((item, index) => void inspectPdf(item, index))
    } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong') }
    finally { setLoading(false) }
  }

  async function searchGoogle(term: string): Promise<SearchItem[]> {
    const q = `${term}${site ? ` site:${site}` : ''}`
    const url = new URL('https://www.googleapis.com/customsearch/v1')
    url.search = new URLSearchParams({ key: config.key, cx: config.cx, q, fileType: 'pdf', num: '10', ...(sort === 'date' ? { sort: 'date' } : {}) }).toString()
    const response = await fetch(url); const data = await response.json()
    if (!response.ok) throw new Error(data.error?.message || 'Google search failed')
    return (data.items || []).map((x: any) => ({ title: x.title.replace(/\s*-?\s*PDF$/i, ''), link: x.link, displayLink: x.displayLink, snippet: x.snippet, thumbnail: x.pagemap?.cse_thumbnail?.[0]?.src, date: x.pagemap?.metatags?.[0]?.['article:published_time']?.slice(0, 4), source: 'Google' }))
  }

  async function searchOpenAlex(term: string): Promise<SearchItem[]> {
    const url = new URL('https://api.openalex.org/works')
    url.search = new URLSearchParams({ search: term, filter: 'has_fulltext:true,is_oa:true', per_page: '20', select: 'id,title,publication_year,authorships,best_oa_location,primary_location,abstract_inverted_index' }).toString()
    const response = await fetch(url); if (!response.ok) throw new Error('OpenAlex failed')
    const data = await response.json()
    return (data.results || []).flatMap((x: any) => {
      const link = x.best_oa_location?.pdf_url || x.primary_location?.pdf_url
      if (!link || (site && !link.includes(site))) return []
      const authors = (x.authorships || []).slice(0, 3).map((a: any) => a.author?.display_name).filter(Boolean).join(', ')
      const abstract = abstractText(x.abstract_inverted_index)
      return [{ title: x.title || 'Untitled document', link, displayLink: new URL(link).hostname, snippet: abstract || (authors ? `By ${authors}. Open-access scholarly document.` : 'Open-access scholarly document.'), date: String(x.publication_year || ''), source: 'OpenAlex' }]
    })
  }

  async function searchInternetArchive(term: string): Promise<SearchItem[]> {
    const escaped = term.replace(/["\\]/g, ' ').trim()
    const url = new URL('https://archive.org/advancedsearch.php')
    url.search = new URLSearchParams({ q: `(title:("${escaped}") OR description:("${escaped}")) AND mediatype:texts AND format:"PDF"`, 'fl[]': ['identifier','title','description','date','creator'] as any, rows: '12', page: '1', output: 'json', sort: sort === 'date' ? 'date desc' : 'downloads desc' }).toString()
    // URLSearchParams does not preserve repeated fields when created from an object.
    url.searchParams.delete('fl[]'); ['identifier','title','description','date','creator'].forEach(x => url.searchParams.append('fl[]', x))
    const response = await fetch(url); if (!response.ok) throw new Error('Internet Archive failed')
    const data = await response.json()
    const docs = data.response?.docs || []
    const resolved = await Promise.all(docs.map(async (x: any) => {
      try {
        const meta = await (await fetch(`https://archive.org/metadata/${encodeURIComponent(x.identifier)}`)).json()
        const file = (meta.files || []).find((f: any) => /\.pdf$/i.test(f.name) && !/_text\.pdf$/i.test(f.name)) || (meta.files || []).find((f: any) => /\.pdf$/i.test(f.name))
        if (!file) return null
        const link = `https://archive.org/download/${encodeURIComponent(x.identifier)}/${encodeURIComponent(file.name).replace(/%2F/g, '/')}`
        if (site && !link.includes(site)) return null
        const description = Array.isArray(x.description) ? x.description[0] : x.description
        return { title: Array.isArray(x.title) ? x.title[0] : (x.title || x.identifier), link, displayLink: 'archive.org', snippet: String(description || `Digitized text from the Internet Archive${x.creator ? ` by ${x.creator}` : ''}.`).replace(/<[^>]+>/g, '').slice(0, 310), date: String(x.date || '').slice(0,4), size: file.size ? formatBytes(Number(file.size)) : undefined, thumbnail: `https://archive.org/services/img/${encodeURIComponent(x.identifier)}`, source: 'Internet Archive' } as SearchItem
      } catch { return null }
    }))
    return resolved.filter(Boolean) as SearchItem[]
  }

  function abstractText(index: Record<string, number[]> | null) {
    if (!index) return ''
    return Object.entries(index).flatMap(([word, positions]) => positions.map(position => ({ word, position }))).sort((a,b) => a.position-b.position).map(x => x.word).join(' ').slice(0, 310)
  }
  function formatBytes(bytes: number) { return bytes > 1e6 ? `${(bytes/1e6).toFixed(1)} MB` : `${Math.round(bytes/1e3)} KB` }

  async function inspectPdf(item: SearchItem, index: number) {
    if (!item.link.toLowerCase().includes('.pdf')) return
    try {
      const pdf = await pdfjsLib.getDocument({ url: item.link }).promise
      const page = await pdf.getPage(1); const viewport = page.getViewport({ scale: .45 })
      const canvas = document.createElement('canvas'); canvas.width = viewport.width; canvas.height = viewport.height
      await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise
      setItems(old => old.map((x, i) => i === index ? { ...x, pages: pdf.numPages, thumbnail: canvas.toDataURL('image/jpeg', .75) } : x))
    } catch { /* Many PDF hosts disallow browser CORS; search metadata remains usable. */ }
  }

  function submit(e: FormEvent) { e.preventDefault(); void runSearch(query) }
  function saveConfig(e: FormEvent) { e.preventDefault(); localStorage.setItem('gargi-config', JSON.stringify(config)); setShowSettings(false) }
  async function installApp() { if (!installPrompt) return; await installPrompt.prompt(); await installPrompt.userChoice; setInstallPrompt(null) }
  const googleDorkUrl = `https://www.google.com/search?q=${encodeURIComponent(`${query || 'PDF books'} filetype:pdf${site ? ` site:${site}` : ''}`)}`
  const awsDorkUrl = `https://www.google.com/search?q=${encodeURIComponent(`${query || 'PDF books'} filetype:pdf (site:amazonaws.com OR site:s3.amazonaws.com)` )}`

  return <div className="page-shell">
    <header><a className="brand" href="./"><span className="brand-mark"><BookOpen size={23}/></span><span>Gargi<span>Library</span></span></a><nav><a href="./about.html">About</a><a href="https://github.com/Rickymorty7x/GargiLibrary" target="_blank">GitHub</a>{installPrompt && <button className="install-btn" onClick={installApp}>Install app</button>}<button className="icon-btn" onClick={() => setShowSettings(true)} aria-label="Search API settings"><Settings size={20}/></button></nav></header>
    <main>
      <section className={`hero ${items.length || loading ? 'compact' : ''}`}>
        <div className="eyebrow"><Sparkles size={14}/> A quieter way to search</div>
        <h1>Find knowledge,<br/><em>one PDF at a time.</em></h1>
        <p>Research papers, books, reports and manuals—without the noise.</p>
        <form className="search-box" onSubmit={submit}>
          <Search size={22}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search for a topic, title, or author…" aria-label="Search PDFs" autoFocus/><button>Search PDFs</button>
        </form>
        <div className="tips"><span>Try:</span>{['machine learning', 'ancient history', 'design systems'].map(x => <button key={x} onClick={() => {setQuery(x); void runSearch(x)}}>{x}</button>)}</div>
        <div className="dork-links">
          <a className="dork-link" href={googleDorkUrl} target="_blank" rel="noopener noreferrer">Google PDF dork <ExternalLink size={13}/></a>
          <a className="dork-link" href={awsDorkUrl} target="_blank" rel="noopener noreferrer">Search AWS/S3 PDFs <ExternalLink size={13}/></a>
        </div>
      </section>

      {(items.length > 0 || loading || error) && <section className="results-wrap">
        <aside><h3><Filter size={17}/> Refine</h3><label>Website domain<input placeholder="e.g. arxiv.org" value={site} onChange={e => setSite(e.target.value)}/></label><label>Sort by<select value={sort} onChange={e => setSort(e.target.value)}><option value="relevance">Relevance</option><option value="date">Newest first</option></select></label><div className="source-note"><Library size={18}/><div><strong>PDF-first results</strong><small>Only document results are requested from the search provider.</small></div></div></aside>
        <div className="results"><div className="results-head"><div><span>{resultLabel}</span>{!configured && items.length > 0 && <small>Open-index results</small>}</div></div>
          {loading && <div className="state"><LoaderCircle className="spin"/> Searching the stacks…</div>}
          {error && <div className="state error">{error}</div>}
          {!loading && searched && !error && !items.length && <div className="state">No open PDFs found. Try a broader phrase or the Google PDF dork.</div>}
          {items.map((item, i) => <article className="result-card" key={item.link}>
            <div className="cover">{item.thumbnail ? <img src={item.thumbnail} alt=""/> : <FileText size={44}/>}<span>PDF</span></div>
            <div className="result-copy"><div className="domain">{item.source || 'PDF'} · {item.displayLink}</div><h2><a href={item.link} target="_blank" rel="noopener noreferrer">{item.title}</a></h2><p>{item.snippet}</p><div className="meta">{item.pages && <span>{item.pages} pages</span>}{item.date && <span>{item.date}</span>}{item.size && <span>{item.size}</span>}</div></div>
            <a className="open" href={item.link} target="_blank" rel="noopener noreferrer" aria-label={`Open ${item.title}`}><ExternalLink size={19}/></a>
          </article>)}
        </div>
      </section>}
      {!items.length && !loading && <section className="features" id="about"><div><FileText/><h3>PDFs, not pages</h3><p>Focused document results with direct source links.</p></div><div><BookOpen/><h3>Useful context</h3><p>Page counts and cover previews when sources allow it.</p></div><div><KeyRound/><h3>Your keys stay yours</h3><p>API credentials remain in your own browser.</p></div></section>}
    </main>
    <footer><span>© 2026 GargiLibrary · MIT License</span><span>Developed entirely with AI using OpenAI Codex.</span></footer>
    {showSettings && <div className="modal-backdrop" onMouseDown={() => setShowSettings(false)}><div className="modal" onMouseDown={e => e.stopPropagation()}><button className="modal-x" onClick={() => setShowSettings(false)}><X/></button><KeyRound/><h2>Connect Google Search</h2><p>Add a Google Programmable Search API key and Search Engine ID. They stay in this browser only.</p><form onSubmit={saveConfig}><label>API key<input type="password" required value={config.key} onChange={e => setConfig({...config, key:e.target.value})}/></label><label>Search engine ID (cx)<input required value={config.cx} onChange={e => setConfig({...config, cx:e.target.value})}/></label><button>Save settings</button></form><a href="https://developers.google.com/custom-search/v1/overview" target="_blank">Google setup guide <ExternalLink size={13}/></a></div></div>}
  </div>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>)
