import {
  clearCache,
  layout,
  measureNaturalWidth,
  type PreparedText,
  prepare,
} from '@chenglou/pretext';
import {
  measureRichInlineStats,
  type PreparedRichInline,
  prepareRichInline,
  type RichInlineBox,
  type RichInlineItem,
} from '@chenglou/pretext/rich-inline';

export interface CardSizingInput {
  title: string;
  company: string;
  location: string;
  panels: { label: string; text: string; hint: string }[];
  dates: string[];
  source: string;
  actions: string[];
  errors: string[];
}

export interface CardSizer {
  clear(): void;
  configure(input: CardSizingInput): boolean;
  estimate(input: CardSizingInput): number;
}

interface TextStyle {
  font: string;
  lineHeight: number;
  letterSpacing: number;
  width: number;
}

interface CardMetrics {
  title: TextStyle;
  company: TextStyle;
  location: TextStyle;
  explanation: TextStyle;
  hint: TextStyle;
  dates: TextStyle;
  button: TextStyle;
  error: TextStyle;
  locationPrefix: number;
  metadataGap: number;
  summaryChrome: number;
  border: number;
  hintMargin: number;
  adminChrome: number;
  actionGap: number;
  buttonChrome: number;
  buttonHeight: number;
  errorChrome: number;
  errorMargin: number;
  fallback: number;
}

const px = (value: string) => Number.parseFloat(value) || 0;
const child = (root: ParentNode, selector: string): HTMLElement => {
  const element = root.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing card element: ${selector}`);
  return element;
};
const cloneTemplate = (root: ParentNode): HTMLElement => {
  const template = root.querySelector('template');
  const element = template?.content.firstElementChild?.cloneNode(true);
  if (!(element instanceof HTMLElement))
    throw new Error('Missing card template');
  return element;
};
const textStyle = (element: HTMLElement): TextStyle => {
  const style = getComputedStyle(element);
  return {
    font: `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
    lineHeight: px(style.lineHeight),
    letterSpacing: px(style.letterSpacing),
    width:
      element.getBoundingClientRect().width -
      px(style.paddingLeft) -
      px(style.paddingRight) -
      px(style.borderLeftWidth) -
      px(style.borderRightWidth),
  };
};

// Read layout chrome from one inert copy of the real template, not a second CSS model.
function calibrate(list: HTMLElement, input: CardSizingInput): CardMetrics {
  const probe = document.createElement('div');
  probe.setAttribute('x-ignore', '');
  probe.setAttribute('aria-hidden', 'true');
  probe.inert = true;
  probe.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;top:0;left:0;width:${list.clientWidth}px;contain:layout;`;
  const row = cloneTemplate(list);
  row.style.position = 'relative';
  child(row, '.job-row__title').textContent = input.title;
  child(row, '.job-row__metadata > span:first-child').textContent =
    input.company;
  child(row, '.job-row__location').textContent = input.location;
  const summary = child(row, '.job-row__summary');
  for (const panel of input.panels) {
    const section = cloneTemplate(summary);
    child(section, '.assessment__status').textContent = panel.label;
    child(section, '.assessment__text').textContent = panel.text;
    child(section, '.assessment__hint').textContent = panel.hint;
    summary.append(section);
  }
  for (const [index, date] of Array.from(
    row.querySelectorAll('.job-row__date'),
  ).entries())
    date.textContent = input.dates[index];
  child(row, '.job-row__source').textContent = input.source;
  for (const action of Array.from(
    row.querySelectorAll<HTMLElement>('.job-row__actions > *'),
  ))
    action.style.display = input.actions.includes(
      action.textContent?.trim() || '',
    )
      ? ''
      : 'none';
  const errors = child(row, '.job-row__errors');
  const error = cloneTemplate(errors);
  for (const text of input.errors) {
    const paragraph = error.cloneNode(true);
    paragraph.textContent = text;
    errors.append(paragraph);
  }
  probe.append(row);
  list.parentElement?.append(probe);
  try {
    const fallback = row.getBoundingClientRect().height;
    // An empty error sample supplies typography without affecting the fallback height.
    error.textContent = 'M';
    errors.append(error);
    const admin = child(row, '.job-row__admin');
    const summaryCss = getComputedStyle(summary);
    const adminCss = getComputedStyle(admin);
    const button = child(row, '.button');
    const buttonCss = getComputedStyle(button);
    const errorCss = getComputedStyle(error);
    const rowCss = getComputedStyle(row);
    const sourceCss = getComputedStyle(child(row, '.job-row__source'));
    const actionsCss = getComputedStyle(child(row, '.job-row__actions'));
    const hint = child(row, '.assessment__hint');
    const location = child(row, '.job-row__location');
    const prefixCss = getComputedStyle(location, '::before');
    const companyStyle = textStyle(
      child(row, '.job-row__metadata > span:first-child'),
    );
    const locationStyle = textStyle(location);
    const width = textStyle(child(row, '.job-row__title')).width;
    const adminWidth = textStyle(admin).width;
    return {
      title: textStyle(child(row, '.job-row__title')),
      company: { ...companyStyle, width },
      location: { ...locationStyle, width },
      explanation: textStyle(child(row, '.assessment__explanation')),
      hint: textStyle(hint),
      dates: { ...textStyle(child(row, '.job-row__dates')), width: adminWidth },
      button: { ...textStyle(button), width: adminWidth },
      error: textStyle(error),
      locationPrefix: px(prefixCss.marginRight),
      metadataGap: px(
        getComputedStyle(child(row, '.job-row__metadata')).columnGap,
      ),
      summaryChrome:
        px(summaryCss.paddingTop) +
        px(summaryCss.paddingBottom) +
        input.panels.length * px(summaryCss.rowGap) +
        Array.from(row.querySelectorAll<HTMLElement>('.assessment')).reduce(
          (sum, panel) => {
            const style = getComputedStyle(panel);
            return (
              sum +
              px(style.paddingTop) +
              px(style.borderTopWidth) +
              px(style.rowGap) +
              child(panel, '.assessment__heading').getBoundingClientRect()
                .height
            );
          },
          0,
        ),
      border: px(rowCss.borderTopWidth) + px(rowCss.borderBottomWidth),
      hintMargin: px(getComputedStyle(hint).marginLeft),
      adminChrome:
        px(adminCss.paddingTop) +
        px(adminCss.paddingBottom) +
        px(sourceCss.lineHeight) +
        px(sourceCss.borderTopWidth) +
        px(sourceCss.borderBottomWidth) +
        px(sourceCss.paddingTop) +
        px(sourceCss.paddingBottom) +
        px(sourceCss.marginTop) +
        px(actionsCss.paddingTop),
      actionGap: px(actionsCss.gap),
      buttonChrome:
        px(buttonCss.paddingLeft) +
        px(buttonCss.paddingRight) +
        px(buttonCss.borderLeftWidth) +
        px(buttonCss.borderRightWidth),
      buttonHeight: Math.max(
        px(buttonCss.minHeight),
        px(buttonCss.lineHeight) +
          px(buttonCss.paddingTop) +
          px(buttonCss.paddingBottom) +
          px(buttonCss.borderTopWidth) +
          px(buttonCss.borderBottomWidth),
      ),
      errorChrome: px(errorCss.paddingTop) + px(errorCss.paddingBottom),
      errorMargin: Math.max(px(errorCss.marginTop), px(errorCss.marginBottom)),
      fallback,
    };
  } finally {
    probe.remove();
  }
}

export function createCardSizer(list: HTMLElement): CardSizer {
  const supported =
    typeof Intl.Segmenter === 'function' &&
    document.createElement('canvas').getContext('2d') !== null;
  const prepared = new Map<string, PreparedText>();
  const richPrepared = new Map<string, PreparedRichInline>();
  let metrics: CardMetrics | null = null;
  let dirty = true;
  let width = 0;
  let pixelRatio = window.devicePixelRatio;
  const getPrepared = (text: string, style: TextStyle) => {
    const key = JSON.stringify([text, style.font, style.letterSpacing]);
    let result = prepared.get(key);
    if (!result) {
      result = prepare(text, style.font, {
        letterSpacing: style.letterSpacing,
      });
      prepared.set(key, result);
    }
    return result;
  };
  const natural = (text: string, style: TextStyle) =>
    measureNaturalWidth(getPrepared(text, style));
  const height = (text: string, style: TextStyle) =>
    layout(getPrepared(text, style), Math.max(1, style.width), style.lineHeight)
      .height;
  const richHeight = (
    items: (RichInlineItem | RichInlineBox)[],
    style: TextStyle,
    whiteSpace: 'normal' | 'pre-wrap' = 'normal',
  ) => {
    const key = JSON.stringify([items, whiteSpace]);
    let result = richPrepared.get(key);
    if (!result) {
      result = prepareRichInline(items, { whiteSpace });
      richPrepared.set(key, result);
    }
    return (
      measureRichInlineStats(result, Math.max(1, style.width)).lineCount *
      style.lineHeight
    );
  };
  const clear = () => {
    // ResizeObserver can request an estimate before the next layout calibration.
    dirty = true;
    prepared.clear();
    richPrepared.clear();
    clearCache();
  };
  return {
    clear,
    configure(input: CardSizingInput) {
      if (pixelRatio !== window.devicePixelRatio) {
        clear();
        pixelRatio = window.devicePixelRatio;
      }
      if (metrics && !dirty && width === list.clientWidth) return false;
      width = list.clientWidth;
      metrics = calibrate(list, input);
      dirty = false;
      return true;
    },
    estimate(input: CardSizingInput) {
      if (!metrics)
        throw new Error('Card sizing must be configured before estimating');
      if (!supported) return metrics.fallback;
      const m = metrics;
      const prefix = m.locationPrefix + natural('·', m.location);
      const companyHeight = height(input.company, m.company);
      const locationHeight = richHeight(
        [
          { width: prefix },
          {
            text: input.location,
            font: m.location.font,
            letterSpacing: m.location.letterSpacing,
          },
        ],
        m.location,
      );
      const metadataHeight =
        natural(input.company, m.company) +
          natural(input.location, m.location) +
          prefix +
          m.metadataGap <=
        m.title.width
          ? Math.max(companyHeight, locationHeight)
          : companyHeight + locationHeight;
      const explanations = input.panels.reduce((sum, panel) => {
        // CSS pre-line collapses horizontal whitespace but preserves hard line breaks.
        const text = panel.text
          .replace(/\r\n?/g, '\n')
          .split('\n')
          .map((line) => line.replace(/[\t\f ]+/g, ' ').replace(/^ | $/g, ''))
          .join('\n');
        return (
          sum +
          richHeight(
            [
              {
                text,
                font: m.explanation.font,
                letterSpacing: m.explanation.letterSpacing,
              },
              {
                text: ` ${panel.hint}`,
                font: m.hint.font,
                letterSpacing: m.hint.letterSpacing,
                extraWidth: m.hintMargin,
              },
            ],
            m.explanation,
            'pre-wrap',
          )
        );
      }, 0);
      const errors = input.errors.length
        ? input.errors.reduce(
            (sum, text) => sum + height(text, m.error) + m.errorChrome,
            0,
          ) +
          (input.errors.length + 1) * m.errorMargin
        : 0;
      let actionRows = 0;
      let rowWidth = 0;
      for (const text of input.actions) {
        const itemWidth = natural(text, m.button) + m.buttonChrome;
        if (
          !actionRows ||
          rowWidth + m.actionGap + itemWidth > m.button.width
        ) {
          actionRows++;
          rowWidth = itemWidth;
        } else rowWidth += m.actionGap + itemWidth;
      }
      const actions =
        actionRows * m.buttonHeight + Math.max(0, actionRows - 1) * m.actionGap;
      const admin =
        m.adminChrome +
        actions +
        input.dates.reduce((sum, text) => sum + height(text, m.dates), 0);
      const summary =
        m.summaryChrome +
        height(input.title, m.title) +
        metadataHeight +
        explanations +
        errors;
      return Math.ceil(m.border + Math.max(summary, admin));
    },
  };
}
