import { CheckoutPanel } from './CheckoutPanel';
import { useEffect, useState } from 'react';
import { formatCurrency, closingLabel } from './catalog';
import { useAuctionData } from './useAuctionData';
import { BidPanel } from './BidPanel';
import { useAuctionDeadline } from './useAuctionDeadline';
import { CreateAuction } from './CreateAuction';
import './publish.css';
import { ProductArt } from './components/ProductArt';
import { ProductCard } from './components/ProductCard';
import { SiteHeader } from './components/SiteHeader';
import { useMarketplace } from './useMarketplace';
import { NotificationPopup } from './NotificationPopup';

const themes = [
  { id: 'marketplace', name: 'Marketplace', description: 'Bright, familiar & made to browse', number: '01' },
  { id: 'journal', name: 'Auction Journal', description: 'Warm paper & timeless typography', number: '02' },
  { id: 'terminal', name: 'Terminal', description: 'After dark, with an electric edge', number: '03' },
] as const;
type Theme = typeof themes[number]['id'];

function savedTheme(): Theme {
  try {
    const saved = localStorage.getItem('auction-house-theme');
    return themes.find((theme) => theme.id === saved)?.id ?? 'marketplace';
  } catch { return 'marketplace'; }
}

function ThemePicker({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  return <section className="theme-picker container" aria-label="Choose a visual theme">
    <div className="theme-intro"><span className="eyebrow">One collection. Three perspectives.</span><p>Make yourself at home.</p></div>
    <div className="theme-options" role="group" aria-label="Visual themes">{themes.map((option) =>
      <button key={option.id} type="button" className={'theme-option ' + option.id} aria-pressed={theme === option.id} onClick={() => onChange(option.id)}>
        <span className="theme-swatch" aria-hidden="true"><i /><i /><i /></span>
        <span><strong>{option.name}</strong><small>{option.description}</small></span>
        <span className="theme-number" aria-hidden="true">{theme === option.id ? '✓' : option.number}</span>
      </button>
    )}</div>
  </section>;
}

function HomePage({ query, theme, onThemeChange }: { query: string; theme: Theme; onThemeChange: (theme: Theme) => void }) {
  const { data: items, loading, error, retry } = useAuctionData(query, false);
  return <main>
    <ThemePicker theme={theme} onChange={onThemeChange} />
    <section className="hero container"><div><p className="eyebrow">A second life. A first-class upgrade.</p><h1>Serious hardware.<br /><em>Extraordinary finds.</em></h1><p>Discover remarkable equipment with a story to tell. Remarkable finds, ready for their next chapter.</p><a className="hero-action" href="#auctions">Explore the collection <span aria-hidden="true">↗</span></a><div className="hero-note"><span aria-hidden="true">●</span> Published auctions · Built for discovery</div></div><div className="hero-rack" aria-hidden="true"><span className="rack-light one" /><span className="rack-light two" /><span className="rack-light three" /><div className="rack-unit"><b>GPU–08</b><i /><i /><i /><i /></div><div className="rack-unit"><b>CORE–96</b><i /><i /><i /><i /></div><div className="rack-unit"><b>MEM–1.5T</b><i /><i /><i /><i /></div><span className="rack-caption">HIGH PERFORMANCE / NEXT CHAPTER</span></div></section>
    <section className="catalog-section container" id="auctions"><div className="section-heading"><div><p className="eyebrow">The collection · {String(items.length).padStart(2, '0')} finds</p><h2>{query ? 'Results for “' + query + '”' : 'Equipment worth watching'}</h2></div>{query ? <a href="/#auctions">Clear search <span aria-hidden="true">×</span></a> : <span className="catalog-note">Good hardware deserves another chapter.</span>}</div>
      {loading ? <p role="status">Loading auctions…</p> : error ? <div role="alert"><p>{error}</p><button onClick={retry}>Retry</button></div> : items.length ? <div className="product-grid">{items.map((item) => <ProductCard key={item.slug} item={item} />)}</div> : <div className="empty-state"><h2>No equipment found</h2><p>Try “GPU”, “memory”, or browse the complete collection.</p><a href="/#auctions">View all auctions</a></div>}
    </section>
  </main>;
}

function ItemPage({ slug, userId, canBid }: { slug: string; userId: string; canBid: boolean }) {
  const { data, loading, error, retry, update, liveStatus } = useAuctionData(slug, true);
  const item = data[0];
  const deadlineEnded = useAuctionDeadline(item?.endsAt, retry);
  const ended = deadlineEnded || item?.isClosed === true;
  useEffect(() => { if (item) document.title = item.title + ' · Auction House'; }, [item]);
  if (loading) return <main className="container empty-state" role="status">Loading auction…</main>;
  if (error && !item) return <main className="container empty-state" role="alert"><p>{error}</p><button onClick={retry}>Retry</button></main>;
  if (!item) return <main className="container empty-state"><h1>Auction not found</h1><p>This auction does not exist.</p><a href="/">Back to all auctions</a></main>;
  return <main className="item-page container">
    <div className="breadcrumbs"><a href="/">Home</a><span>/</span><a href={'/?q=' + encodeURIComponent(item.category) + '#auctions'}>{item.category}</a><span>/</span><span>{item.title}</span></div>
    <div className="item-layout"><div className="item-gallery"><ProductArt kind={item.art} label={'Illustration of ' + item.title} /><p className="image-caption">Illustrated catalog image</p></div>
      <section className="item-summary"><p className="product-category">{item.category} · {item.condition}</p><h1>{item.title}</h1>
        <div className="auction-panel"><div className="current-price"><span>{item.bidCount ? 'Current bid' : 'Starting price'}</span><strong data-testid="current-price">{formatCurrency(item.currentPriceMinor)}</strong><small>{item.bidCount} accepted {item.bidCount === 1 ? 'bid' : 'bids'}</small></div><div className="ending"><span>Status</span><strong data-testid="auction-status">{ended ? 'Ended' : closingLabel(item.endsAt)}</strong></div></div>
        <p role="status" data-testid="live-status">{liveStatus}</p>
        {error && <p role="alert">{error} <button onClick={retry}>Retry refresh</button></p>}
        <BidPanel item={item} userId={userId} enabled={canBid} closed={ended} update={update} refresh={retry} />
        {item.finalOutcome && <section className="final-outcome" aria-labelledby="final-outcome-title" data-testid="final-outcome">
          <p className="eyebrow">Auction outcome</p><h2 id="final-outcome-title">Final result</h2>
          {item.finalOutcome.winningBid
            ? <p><strong>{item.finalOutcome.winningBid.bidderName}</strong> won at <strong>{formatCurrency(item.finalOutcome.winningBid.amountMinor)}</strong>.</p>
            : <p>No bids were placed. This auction closed without a winner.</p>}
          <small>Closed {new Date(item.finalOutcome.closedAt).toLocaleString()}</small>
        </section>}
        {item.finalOutcome?.winningBid && (item.finalOutcome.winningBid.bidderId === userId || item.sellerId === userId) && <CheckoutPanel role={item.sellerId === userId ? 'seller' : 'winner'} key={slug + userId} slug={slug} userId={userId} amountMinor={item.finalOutcome.winningBid.amountMinor} />}
        <div className="seller-card"><span className="seller-avatar">{item.seller.charAt(0)}</span><div><small>Sold by</small><strong>{item.seller}</strong><span>Demo user · No authentication</span><span>{item.location ?? 'Location not provided'}</span></div></div>
      </section>
    </div>
    <div className="item-details-grid"><section><p className="eyebrow">About this item</p><h2>The details</h2><p>{item.description}</p></section>{item.specs.length > 0 && <section className="spec-list"><p className="eyebrow">Specifications</p>{item.specs.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</section>}</div>
    <section className="bid-history" aria-label="Bid history"><h2>Bid history</h2>{item.bids.length ? <ol>{item.bids.map((bid) => <li key={bid.id} data-testid="bid-history-entry"><strong>{bid.bidderName}</strong><span>{formatCurrency(bid.amountMinor)}</span><time dateTime={bid.acceptedAt}>{new Date(bid.acceptedAt).toLocaleString()}</time></li>)}</ol> : <p>No bids yet.</p>}</section>
    <a className="back-link" href="/#auctions">← Back to the collection</a>
  </main>;
}

export function App() {
  const marketplace = useMarketplace();
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const path = window.location.pathname;
  const query = new URLSearchParams(window.location.search).get('q') ?? '';
  let slug = '';
  try { slug = decodeURIComponent(path.slice('/items/'.length)); } catch { /* Invalid URLs show the missing-item state. */ }
  const isItem = path.startsWith('/items/');
  useEffect(() => {
    document.title = isItem ? 'Auction details · Auction House' : path === '/auctions/new' ? 'Post an auction · Auction House' : 'Auction House · Remarkable hardware';
  }, [isItem, slug]);
  useEffect(() => {
    try { localStorage.setItem('auction-house-theme', theme); } catch { /* Theme switching also works without storage. */ }
  }, [theme]);
  return <div className="app-shell" data-theme={theme}>
    <NotificationPopup userId={marketplace.activeUserId} />
    <SiteHeader initialQuery={query} canPost={marketplace.capabilities.postAuctions} activeUserName={marketplace.users.find((user) => user.id === marketplace.activeUserId)?.displayName} />
    {path === '/auctions/new' ? marketplace.error ? <main className="container empty-state" role="alert"><p>{marketplace.error}</p><button type="button" onClick={marketplace.retry}>Retry marketplace</button></main> : marketplace.users.length === 0 ? <main className="container empty-state" role="status">Loading auction form…</main> : marketplace.capabilities.postAuctions ? <CreateAuction activeUser={marketplace.users.find((user) => user.id === marketplace.activeUserId)} /> : <main className="container empty-state"><h1>Posting is not available yet</h1><p>You can browse auctions and switch demo users.</p><a href="/">Back to all auctions</a></main> : path === '/' ? <HomePage query={query} theme={theme} onThemeChange={setTheme} /> : isItem ? <ItemPage slug={slug} userId={marketplace.activeUserId} canBid={marketplace.capabilities.placeBids} /> : <main className="container empty-state"><h1>Page not found</h1><a href="/">Back to all auctions</a></main>}
    <footer><div className="container"><span>Auction House</span><span>Auctions in USD</span><div className="user-switcher">
      {marketplace.error ? <div role="alert">{marketplace.error} <button type="button" onClick={marketplace.retry}>Retry users</button></div> : marketplace.users.length === 0 ? <span role="status">Loading demo users…</span> : <>
        <label htmlFor="demo-user">Active demo user</label>
        <select id="demo-user" value={marketplace.activeUserId} onChange={(event) => marketplace.switchUser(event.target.value)}>{marketplace.users.map((user) => <option key={user.id} value={user.id}>{user.displayName}</option>)}</select>
        <small>No authentication · Selection saved for this tab</small>
      </>}
    </div></div></footer>
  </div>;
}
