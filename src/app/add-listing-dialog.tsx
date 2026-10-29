'use client';

import { useRef, useState } from 'react';

export function AddListingDialog({
  onAdd,
}: {
  onAdd: (url: string) => Promise<{ added: boolean }>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  return (
    <>
      <button
        className="button"
        type="button"
        onClick={() => {
          setMessage('');
          dialog.current?.showModal();
        }}
      >
        Add URL
      </button>
      <dialog
        ref={dialog}
        className="add-dialog"
        aria-labelledby="add-listing-title"
      >
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            setBusy(true);
            setMessage('');
            try {
              const result = await onAdd(url);
              setMessage(
                result.added
                  ? 'Listing added and queued.'
                  : 'This listing already exists.',
              );
              if (result.added) setUrl('');
            } catch (error) {
              setMessage(
                error instanceof Error
                  ? error.message
                  : 'Could not add listing.',
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2 id="add-listing-title">Add a listing</h2>
          <label htmlFor="listing-url">Job listing URL</label>
          <input
            id="listing-url"
            type="url"
            required
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/jobs/123"
          />
          {message && <p role="status">{message}</p>}
          <div className="add-dialog__actions">
            <button
              type="button"
              className="button"
              onClick={() => dialog.current?.close()}
            >
              Close
            </button>
            <button
              type="submit"
              className="button button--primary"
              disabled={busy}
            >
              {busy ? 'Adding…' : 'Add listing'}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
