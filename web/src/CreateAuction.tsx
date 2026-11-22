import { useState, type FormEvent } from 'react';
import type { DemoUser } from './marketplace';

export function CreateAuction({ activeUser }: { activeUser: DemoUser | undefined }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});

  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    if (!activeUser) {
      setError('Choose a demo user in the footer before publishing.');
      return;
    }
    const form = event.currentTarget;
    const values = new FormData(form);
    const endsAt = new Date(String(values.get('endsAt')));
    if (!Number.isFinite(endsAt.getTime()) || endsAt.getTime() <= Date.now()) {
      setFields({ endsAt: 'Choose a closing time in the future.' });
      setError('Please check the highlighted fields.');
      return;
    }
    setSaving(true);
    setError('');
    setFields({});
    try {
      const response = await fetch('/api/auctions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...Object.fromEntries(values), sellerId: activeUser.id, endsAt: endsAt.toISOString() }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const errors: Record<string, string> = {};
        if (typeof body === 'object' && body !== null && 'errors' in body && typeof body.errors === 'object' && body.errors !== null) {
          for (const [key, messages] of Object.entries(body.errors)) {
            if (Array.isArray(messages) && typeof messages[0] === 'string') errors[key] = messages[0];
          }
          setFields(errors);
        }
        if (errors.sellerId) throw new Error(errors.sellerId);
        throw new Error(response.status === 400 ? 'Please check the highlighted fields.' : 'The auction could not be published. Please try again.');
      }
      if (typeof body !== 'object' || body === null || !('slug' in body) || typeof body.slug !== 'string') throw new Error('Unable to confirm publication. Check the collection before trying again.');
      window.location.assign(`/items/${encodeURIComponent(body.slug)}`);
    } catch (reason) {
      setError(reason instanceof TypeError ? 'Connection lost. Check the collection before retrying: your auction may have been saved.' : reason instanceof Error ? reason.message : 'Unable to confirm publication. Check the collection before retrying.');
      setSaving(false);
    }
  }

  const fieldError = (name: string) => fields[name] ? <small className="field-error" id={`${name}-error`}>{fields[name]}</small> : null;
  const validation = (name: string) => ({ 'aria-invalid': !!fields[name], 'aria-describedby': fields[name] ? `${name}-error` : undefined });

  return <main className="container publish-page">
    <a className="back-link" href="/">← Back to the collection</a>
    <p className="eyebrow">Give great hardware its next chapter</p><h1>Post an auction</h1>
    <p>Publish immediately. All prices are in USD ($). Other demo users can bid until the auction closes.</p>
    <p className="selling-as" role="status">{activeUser ? <>Selling as <strong>{activeUser.displayName}</strong>. Change the active demo user in the footer.</> : 'Choose a demo user in the footer to publish.'}</p>
    <form className="publish-form" onSubmit={publish}>
      <fieldset disabled={saving || !activeUser}>
        <legend>Auction details</legend>
        <label>Title<input name="title" required maxLength={120} {...validation('title')} />{fieldError('title')}</label>
        <label>Description<textarea name="description" required maxLength={5000} rows={5} {...validation('description')} />{fieldError('description')}</label>
        <div className="form-columns">
          <label>Category<select name="category" required defaultValue="" {...validation('category')}><option value="" disabled>Choose a category</option>{['GPUs','CPUs','Memory','Chassis','Networking','Cooling','Other'].map((category) => <option key={category}>{category}</option>)}</select>{fieldError('category')}</label>
          <label>Condition<input name="condition" required maxLength={100} placeholder="e.g. Used · Fully tested" {...validation('condition')} />{fieldError('condition')}</label>
          <label>Location<input name="location" required maxLength={200} placeholder="e.g. Austin, TX" {...validation('location')} />{fieldError('location')}</label>
          <label>Starting price (USD)<input name="startingPrice" type="text" required pattern="(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,2})?" title="USD 0.01–9,999,999.99, with at most two decimal places" inputMode="decimal" {...validation('startingPrice')} />{fieldError('startingPrice')}<small>$0.01–$9,999,999.99, with up to two decimal places.</small></label>
        </div>
        <label>Closing date and time<input name="endsAt" type="datetime-local" step="1" required {...validation('endsAt')} />{fieldError('endsAt')}<small>Your timezone: {Intl.DateTimeFormat().resolvedOptions().timeZone}. Auctions close at this time.</small></label>
        <p>Published auctions cannot be edited or cancelled. An illustration is chosen from the category.</p>
        <button className="publish-button" type="submit">{saving ? 'Publishing…' : 'Publish auction'}</button>
      </fieldset>
      {error && <div className="form-error" role="alert">{error} <a href="/">View collection</a></div>}
      {saving && <p role="status">Saving your auction…</p>}
    </form>
  </main>;
}
