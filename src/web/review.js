export const stackLabel = (job) => {
  const status = job.stack_status || 'not_checked';
  if (status !== 'not_checked') return status.replaceAll('_', ' ');
  if (['ineligible', 'error'].includes(job.eligibility)) return 'Skipped';
  return 'Not checked';
};
const matchesLocation = (job, eligibility) => {
  if (eligibility === 'all') return true;
  if (job.eligibility === eligibility) return true;
  if (eligibility !== 'error') return false;
  return (job.stages || []).some(
    (stage) =>
      ['crawl', 'location'].includes(stage.stage) &&
      ['failed', 'terminal'].includes(stage.state),
  );
};
const matchesStack = (job, stack) => {
  if (stack === 'all') return true;
  if ((job.stack_status || 'not_checked') === stack) return true;
  if (stack !== 'error') return false;
  return (job.stages || []).some(
    (stage) => stage.stage === 'stack' && stage.state === 'failed',
  );
};
export const matchesAssessments = (job, eligibility, stack) =>
  matchesLocation(job, eligibility) && matchesStack(job, stack);

const viewOptions = {
  status: ['active', 'hidden', 'rejected'],
  eligibility: ['all', 'eligible', 'pending', 'unclear', 'ineligible', 'error'],
  stack: [
    'all',
    'not_checked',
    'pending',
    'match',
    'partial_match',
    'potential_match',
    'unclear',
    'error',
  ],
};
const readView = (url) =>
  Object.fromEntries(
    Object.entries(viewOptions).map(([key, values]) => {
      const value = url.searchParams.get(key);
      return [key, values.includes(value) ? value : values[0]];
    }),
  );
const safeUrl = (value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
};
const displayText = (value, fallback) =>
  (typeof value === 'string' && value.trim()) || fallback;
const assessments = (job) => [
  {
    title: 'Location eligibility',
    status: job.eligibility || 'pending',
    label: job.eligibility || 'pending',
    reason: job.reason,
    evidence: job.evidence,
  },
  {
    title: 'Stack match',
    status: job.stack_status || 'not_checked',
    label: stackLabel(job),
    reason: job.stack_reason,
    evidence: job.stack_evidence,
  },
];

export function jobReview(environment = globalThis) {
  const {
    window,
    document,
    location,
    history,
    fetch,
    setInterval,
    clearInterval,
  } = environment;
  const fetchJobs = async (status, signal) => {
    const response = await fetch(`/api/jobs?status=${status}`, { signal });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error || 'Could not load jobs.');
    if (
      !Array.isArray(body?.jobs) ||
      body.jobs.some(
        (job) => !job || typeof job.reviewKey !== 'string' || !job.reviewKey,
      )
    )
      throw new Error('Invalid jobs response.');
    if (
      new Set(body.jobs.map((job) => job.reviewKey)).size !== body.jobs.length
    )
      throw new Error('Invalid jobs response: duplicate listing keys.');
    return body.jobs;
  };
  const relativeTime = new Intl.RelativeTimeFormat('en', { numeric: 'always' });
  // Keep transport handles outside Alpine's reactive proxies.
  let request = null;
  let timer = null;
  let virtualizer = null;
  let unmountVirtual = null;
  let jobs = [];
  let contents = [];
  let cardSizer = null;
  let widthObserver = null;
  const contentSignatures = new Map();
  let fontsChanged = null;
  return {
    ...readView(new URL(location.href)),
    cache: {},
    pending: {},
    loading: false,
    loadError: '',
    saveError: '',
    message: '',
    now: Date.now(),
    renderedJobs: [],
    totalSize: 0,
    evidenceShown: {},
    safeUrl,
    displayText,
    relativeDate(value) {
      if (typeof value !== 'string' || !value.trim()) return '';
      const timestamp = Date.parse(value);
      if (Number.isNaN(timestamp)) return '';
      const seconds = (timestamp - this.now) / 1000;
      if (Math.abs(seconds) < 1) return 'just now';
      for (const [unit, size] of [
        ['year', 31536000],
        ['month', 2592000],
        ['week', 604800],
        ['day', 86400],
        ['hour', 3600],
        ['minute', 60],
        ['second', 1],
      ]) {
        if (Math.abs(seconds) < size && unit !== 'second') continue;
        return relativeTime.format(Math.trunc(seconds / size), unit);
      }
    },
    assessments,
    cardContent(job) {
      return {
        title: job.title || 'Untitled role',
        company: displayText(job.company, 'Company not provided'),
        location: displayText(job.location, 'Location not provided'),
        panels: assessments(job).map((panel) => {
          const evidence =
            !!this.evidenceShown[`${job.reviewKey}:${panel.title}`];
          return {
            label: `${panel.title.split(' ')[0]} ${panel.label}`,
            text: evidence
              ? panel.evidence || 'No evidence available yet.'
              : panel.reason || 'No assessment available yet.',
            hint: evidence ? 'See reason' : 'See evidence',
          };
        }),
        dates: [
          `Posted ${this.relativeDate(job.posted_at) || 'date unknown'}`,
          `Found ${this.relativeDate(job.first_seen) || 'date unknown'}`,
        ],
        source:
          { google: 'Google', freehire: 'Freehire' }[job.source] || 'Unknown',
        actions: [
          ...(safeUrl(job.url) ? ['View'] : []),
          ...(this.status === 'active' ? ['Hide', 'Reject'] : ['Restore']),
        ],
        errors: (job.stages || [])
          .filter((stage) => stage.error)
          .map((stage) => `${stage.stage}: ${stage.state} — ${stage.error}`),
      };
    },
    assessmentState(key, title) {
      const state = this.evidenceShown;
      const panelKey = `${key}:${title}`;
      return {
        get showEvidence() {
          return state[panelKey] || false;
        },
        set showEvidence(value) {
          state[panelKey] = value;
        },
      };
    },
    init() {
      const list = this.$el.querySelector('#jobs');
      cardSizer = window.createCardSizer(list);
      const {
        Virtualizer,
        observeWindowRect,
        observeWindowOffset,
        windowScroll,
      } = window.TanStackVirtual;
      virtualizer = new Virtualizer({
        count: 0,
        getScrollElement: () => window,
        estimateSize: (index) => cardSizer.estimate(contents[index]),
        observeElementRect: observeWindowRect,
        observeElementOffset: observeWindowOffset,
        scrollToFn: windowScroll,
        overscan: 4,
        gap: 16,
        onChange: () => this.renderVirtual(),
      });
      unmountVirtual = virtualizer._didMount();
      this.$nextTick(() => this.syncVirtual());
      let width = list.clientWidth;
      if (window.ResizeObserver) {
        widthObserver = new window.ResizeObserver(() => {
          if (width === list.clientWidth) return;
          width = list.clientWidth;
          this.resizeVirtual();
        });
        widthObserver.observe(list);
      }
      fontsChanged = () => {
        if (!virtualizer) return;
        cardSizer.clear();
        return this.resizeVirtual();
      };
      document.fonts?.addEventListener('loadingdone', fontsChanged);
      timer = setInterval(() => this.refresh(), 5000);
      return (document.fonts?.ready || Promise.resolve()).then(() => {
        if (!virtualizer) return;
        return this.load();
      });
    },
    destroy() {
      clearInterval(timer);
      this.cancelLoad();
      widthObserver?.disconnect();
      document.fonts?.removeEventListener('loadingdone', fontsChanged);
      cardSizer?.clear();
      unmountVirtual?.();
      virtualizer = null;
    },
    resizeVirtual() {
      if (!virtualizer) return;
      return this.preservePosition(() => {});
    },
    syncVirtual(retainedKeys = []) {
      if (!virtualizer) return;
      jobs = this.visibleJobs;
      contents = jobs.map((job) => this.cardContent(job));
      let reset = contents.length ? cardSizer.configure(contents[0]) : false;
      for (const [index, job] of jobs.entries()) {
        const signature = JSON.stringify(contents[index]);
        if (
          contentSignatures.has(job.reviewKey) &&
          contentSignatures.get(job.reviewKey) !== signature
        )
          reset = true;
        contentSignatures.set(job.reviewKey, signature);
      }
      const focusedKey =
        document.activeElement?.closest?.('.job-row')?.dataset.reviewKey;
      const focusedIndex = jobs.findIndex(
        (job) => job.reviewKey === focusedKey,
      );
      virtualizer.setOptions({
        ...virtualizer.options,
        count: jobs.length,
        getItemKey: (index) => jobs[index].reviewKey,
        scrollMargin:
          this.$refs.virtualList.getBoundingClientRect().top + window.scrollY,
        rangeExtractor: (range) => {
          const indexes = window.TanStackVirtual.defaultRangeExtractor(range);
          for (const key of retainedKeys) {
            const index = jobs.findIndex((job) => job.reviewKey === key);
            if (index >= 0) indexes.push(index);
          }
          // Keep keyboard focus and its Tab neighbors mounted when scrolling away.
          if (focusedIndex >= 0)
            for (
              let index = Math.max(0, focusedIndex - 1);
              index <= Math.min(jobs.length - 1, focusedIndex + 1);
              index++
            )
              indexes.push(index);
          return [...new Set(indexes)].sort((a, b) => a - b);
        },
      });
      if (reset) virtualizer.measure();
      virtualizer._willUpdate();
      this.renderVirtual();
    },
    renderVirtual() {
      if (!virtualizer) return;
      this.totalSize = virtualizer.getTotalSize();
      this.renderedJobs = virtualizer.getVirtualItems().map((item) => ({
        ...jobs[item.index],
        virtualIndex: item.index,
        virtualStart: item.start - virtualizer.options.scrollMargin,
      }));
    },
    measureRow(element) {
      if (!element.isConnected || !virtualizer) return;
      virtualizer.measureElement(element);
      virtualizer.measureElement(null);
    },
    get visibleJobs() {
      const jobs = new Map(
        (this.cache[this.status] || []).map((job) => [job.reviewKey, job]),
      );
      for (const [key, change] of Object.entries(this.pending)) {
        if (change.to === this.status) jobs.set(key, change.job);
        else jobs.delete(key);
      }
      return [...jobs.values()].filter((job) =>
        matchesAssessments(job, this.eligibility, this.stack),
      );
    },
    get notice() {
      if (this.saveError || this.loadError)
        return this.saveError || this.loadError;
      if (this.message) return this.message;
      if (this.loading && !this.cache[this.status]) return 'Loading…';
      const count = this.visibleJobs.length;
      return count ? `${count} ${count === 1 ? 'job' : 'jobs'}` : '';
    },
    async selectView(values, writeHistory = true) {
      if (Object.entries(values).every(([key, value]) => this[key] === value))
        return;
      const previousStatus = this.status;
      await this.preservePosition(() => {
        Object.assign(this, values);
        this.saveError = '';
        this.loadError = '';
        this.message = '';
      });
      if (writeHistory) {
        const url = new URL(location.href);
        for (const key of Object.keys(viewOptions)) {
          if (this[key] === viewOptions[key][0]) url.searchParams.delete(key);
          else url.searchParams.set(key, this[key]);
        }
        history.pushState(null, '', url);
      }
      if (previousStatus !== this.status) return this.load(true);
    },
    restoreView() {
      return this.selectView(readView(new URL(location.href)), false);
    },
    refresh() {
      if (document.hidden) return;
      this.now = Date.now();
      return this.load();
    },
    cancelLoad() {
      request?.abort();
      request = null;
      this.loading = false;
    },
    async load(force = false) {
      if (request && !force) return;
      this.cancelLoad();
      const controller = new AbortController();
      request = controller;
      const status = this.status;
      this.loading = true;
      try {
        const jobs = await fetchJobs(status, controller.signal);
        if (request !== controller || this.status !== status) return;
        await this.preservePosition(() => {
          this.cache[status] = jobs;
          this.loadError = '';
        });
      } catch (error) {
        if (request !== controller) return;
        await this.preservePosition(() => {
          this.loadError = error.message || 'Could not load jobs.';
        });
      } finally {
        if (request === controller) {
          request = null;
          this.loading = false;
        }
      }
    },
    async updateStatus(job, to) {
      const key = job.reviewKey;
      if (this.pending[key]) return;
      const from = this.status;
      const index = (this.cache[from] || []).findIndex(
        (item) => item.reviewKey === key,
      );
      this.cancelLoad();
      await this.preservePosition(() => {
        this.pending[key] = { from, to, job };
        this.saveError = '';
        this.message = '';
      });
      try {
        const response = await fetch('/api/jobs/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reviewKey: key, status: to }),
        });
        const body = await response.json();
        if (!response.ok || body?.ok !== true)
          throw new Error(body?.error || 'Could not save that change.');
      } catch (error) {
        await this.preservePosition(() => {
          const jobs = this.cache[from] || [];
          if (!jobs.some((item) => item.reviewKey === key)) {
            const restored = [...jobs];
            restored.splice(Math.max(index, 0), 0, job);
            this.cache[from] = restored;
          }
          delete this.pending[key];
          this.saveError = `${error.message || 'Could not save that change.'} Try again.`;
        });
        return;
      }
      // A read started before the save completed cannot establish current membership.
      this.cancelLoad();
      await this.preservePosition(() => {
        for (const status of Object.keys(this.cache)) {
          this.cache[status] = this.cache[status].filter(
            (item) => item.reviewKey !== key,
          );
        }
        if (this.cache[to]) this.cache[to].push(job);
        delete this.pending[key];
      });
      await this.load(true);
      if (
        to === 'active' &&
        job.stages?.some((stage) => stage.state === 'pending')
      )
        this.message =
          'Restored with unfinished checks. Run pnpm job-hunter repair to restore missing queue work.';
    },
    async preservePosition(change) {
      const cards = [...document.querySelectorAll('.job-row')];
      const positions = cards.map((card) => ({
        key: card.dataset.reviewKey,
        top: card.getBoundingClientRect().top,
        bottom: card.getBoundingClientRect().bottom,
      }));
      const firstVisible = positions.findIndex(
        (position) => position.bottom > 0,
      );
      const anchors =
        firstVisible < 0
          ? []
          : [
              ...positions.slice(firstVisible),
              ...positions.slice(0, firstVisible).reverse(),
            ];
      const focused = cards.findIndex((card) =>
        card.contains(document.activeElement),
      );
      const focusOrder =
        focused < 0
          ? []
          : [
              ...cards.slice(focused + 1),
              ...cards.slice(0, focused).reverse(),
            ].map((card) => card.dataset.reviewKey);
      const activeElement = document.activeElement;
      change();
      await this.$nextTick();
      const keys = new Set(this.visibleJobs.map((job) => job.reviewKey));
      const retainedAnchor = anchors.find((position) => keys.has(position.key));
      const retainedFocus = focusOrder.find((key) => keys.has(key));
      // Anchor and focus targets can move outside overscan after a poll or filter.
      this.syncVirtual([retainedAnchor?.key, retainedFocus]);
      await this.$nextTick();
      const remaining = new Map(
        [...document.querySelectorAll('.job-row')].map((card) => [
          card.dataset.reviewKey,
          card,
        ]),
      );
      const anchor = anchors.find((position) => remaining.has(position.key));
      if (anchor)
        window.scrollBy(
          0,
          remaining.get(anchor.key).getBoundingClientRect().top - anchor.top,
        );
      if (focused >= 0 && !activeElement.isConnected) {
        const nextKey = focusOrder.find((key) => remaining.has(key));
        const target = nextKey
          ? remaining.get(nextKey).querySelector('.job-row__title')
          : document.querySelector(`[data-status="${this.status}"]`);
        target?.focus({ preventScroll: true });
      }
      if (!virtualizer) return;
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      this.syncVirtual();
    },
  };
}
