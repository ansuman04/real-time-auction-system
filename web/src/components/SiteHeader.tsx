export function SiteHeader({ initialQuery, canPost = false, activeUserName }: { initialQuery: string; canPost?: boolean; activeUserName?: string }) {
  return <header className="site-header">
    <div className="container header-main">
      <a className="brand" href="/" aria-label="Auction House home"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>Auction House</span></a>
      <form className="search-form" role="search" action="/">
        <span className="search-icon" aria-hidden="true">⌕</span>
        <input name="q" maxLength={200} aria-label="Search auctions" defaultValue={initialQuery} placeholder="Find your next great upgrade…" />
        <button type="submit">Search</button>
      </form>
      <div className="header-user" aria-label="Current demo user"><small>Active demo user</small><strong>{activeUserName ?? 'Loading…'}</strong>{canPost && <a className="collection-label" href="/auctions/new">Sell ↗</a>}</div>
    </div>
    <nav className="container category-nav" aria-label="Equipment categories">
      {['Featured', 'GPUs', 'CPUs', 'Memory', 'Chassis', 'Networking', 'Cooling'].map((category) => <a key={category} href={category === 'Featured' ? '/#auctions' : '/?q=' + encodeURIComponent(category) + '#auctions'}>{category}</a>)}
    </nav>
  </header>;
}
