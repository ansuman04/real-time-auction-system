import { useAuctionDeadline } from '../useAuctionDeadline';
import { type AuctionItem, formatCurrency, closingLabel } from '../catalog';
import { ProductArt } from './ProductArt';

export function ProductCard({ item }: { item: AuctionItem }) {
  const ended = useAuctionDeadline(item.endsAt);
  return <article className="product-card"><a className="product-image-link" href={`/items/${item.slug}`}><ProductArt kind={item.art} label={`Illustration of ${item.title}`} /><span className="time-pill">{ended || item.isClosed ? 'Ended' : closingLabel(item.endsAt)}</span></a><div className="product-card-body"><p className="product-category">{item.category}</p><h3><a href={`/items/${item.slug}`}>{item.title}</a></h3><p className="product-kicker">{item.condition}</p><div className="price-row"><strong>{formatCurrency(item.currentPriceMinor)}</strong><span>{item.bidCount ? `${item.bidCount} bids` : 'Starting price'}</span></div></div></article>;
}
