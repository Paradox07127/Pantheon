import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import {
  setDiffPrefs,
  TAB_SIZES,
  useDiffPrefs,
  type DiffSwitch,
  type DiffView,
  type TabSize,
} from '../../data/diff-prefs';
import { t } from '../../i18n';
import { Row, Section } from './ProjectSettingsScreen';

// Indented with a tab and long enough to wrap, so the preview shows both choices.
const PREVIEW = [
  { kind: 'del', old: 12, new: null, sign: '−', text: '\treturn rows.filter((row) => row.done);' },
  {
    kind: 'add',
    old: null,
    new: 12,
    sign: '+',
    text: '\treturn rows.filter((row) => row.done && !row.archived && row.owner === viewer.id && row.updatedAt > since);',
  },
] as const;

/** How every diff shows its lines and files; the diff toolbar changes the same choices. */
export function DiffPage() {
  const prefs = useDiffPrefs();
  const viewTitle = t({ id: 'settings.diff.view', defaultMessage: 'Default view' });
  const tabTitle = t({ id: 'settings.diff.tabSize', defaultMessage: 'Tab width' });
  const toggle = (pref: DiffSwitch, label: string, settingId: string) => (
    <Row label={label} settingId={settingId}>
      <input
        type="checkbox"
        className="ps-sw"
        aria-label={label}
        checked={prefs[pref]}
        onChange={(e) => setDiffPrefs({ [pref]: e.target.checked })}
      />
    </Row>
  );
  return (
    <>
      <Section>
        <div className="ps-rows">
          <Row label={viewTitle} settingId="diff.view">
            <RadioGroup<DiffView>
              className="seg"
              aria-label={viewTitle}
              value={prefs.view}
              onValueChange={(view) => setDiffPrefs({ view })}
            >
              <Radio.Root value="unified">
                {t({ id: 'settings.diff.unified', defaultMessage: 'Unified' })}
              </Radio.Root>
              <Radio.Root value="split">
                {t({ id: 'settings.diff.split', defaultMessage: 'Split' })}
              </Radio.Root>
            </RadioGroup>
          </Row>
          <Row label={tabTitle} settingId="diff.tabSize">
            <RadioGroup<TabSize>
              className="seg"
              aria-label={tabTitle}
              value={prefs.tab_size}
              onValueChange={(tab_size) => setDiffPrefs({ tab_size })}
            >
              {TAB_SIZES.map((size) => (
                <Radio.Root key={size} value={size}>
                  {String(size)}
                </Radio.Root>
              ))}
            </RadioGroup>
          </Row>
          {toggle(
            'wrap',
            t({ id: 'components.diff.wrap', defaultMessage: 'Wrap long lines' }),
            'diff.wrap',
          )}
          {toggle(
            'ignore_whitespace',
            t({
              id: 'components.diff.ignoreWhitespace',
              defaultMessage: 'Hide whitespace-only changes',
            }),
            'diff.ignoreWhitespace',
          )}
          {toggle(
            'collapse',
            t({ id: 'components.diff.collapse', defaultMessage: 'Fold files on open' }),
            'diff.collapse',
          )}
        </div>
      </Section>
      <div
        className="ss-dl mono ps-dpv"
        role="img"
        aria-label={t({ id: 'settings.diff.preview', defaultMessage: 'Preview' })}
        data-nowrap={!prefs.wrap || undefined}
        style={{ tabSize: prefs.tab_size }}
      >
        {PREVIEW.map((line) => (
          <div key={line.kind} className={`ss-ln ${line.kind}`}>
            <span className="ss-nums">
              <span>{line.old ?? ''}</span>
              <span>{line.new ?? ''}</span>
            </span>
            <span className="ss-sg">{line.sign}</span>
            <span className="ss-code">{line.text}</span>
          </div>
        ))}
      </div>
    </>
  );
}
