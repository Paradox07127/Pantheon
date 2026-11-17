import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { Menu as BaseMenu } from '@base-ui/react/menu';
import { Check, ChevronRight } from 'lucide-react';
import { t } from '../i18n';
import { keyText } from '../lib/shortcuts';
import './menu.css';

type Positioner = ComponentProps<typeof BaseMenu.Positioner>;

/** The leading icon slot; an item without an icon keeps the slot so every label starts at one edge. */
const Slot = ({ icon }: { icon?: ReactNode }) => (
  <span className="mn-ic" aria-hidden="true">
    {icon}
  </span>
);

/** A menu opened from `trigger`, growing out of it. */
export function Menu({
  trigger,
  label,
  side = 'bottom',
  align = 'start',
  children,
}: {
  /** The button that opens the menu. */
  trigger: ReactElement;
  label: string;
  side?: Positioner['side'];
  align?: Positioner['align'];
  children: ReactNode;
}) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner side={side} align={align} sideOffset={4} style={{ zIndex: 60 }}>
          <BaseMenu.Popup
            className="mn mn-menu pop"
            aria-label={label}
            // Base UI sets --available-height on the positioner; a long menu scrolls inside the window.
            style={{ maxHeight: 'var(--available-height)', overflowY: 'auto' }}
          >
            {children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}

/** An entry; `keys` is a shortcut such as `Meta+\`, shown as a key cap at the end. */
export function MenuItem({
  icon,
  keys,
  danger,
  children,
  ...rest
}: Omit<ComponentProps<typeof BaseMenu.Item>, 'className'> & {
  icon?: ReactNode;
  keys?: string;
  /** Draws the entry in the colour of an action that destroys something. */
  danger?: boolean;
}) {
  return (
    <BaseMenu.Item
      {...rest}
      className={danger ? 'mn-row mn-bad' : 'mn-row'}
      aria-keyshortcuts={keys || undefined}
    >
      <Slot icon={icon} />
      <span className="mn-tx">{children}</span>
      {keys && (
        <span className="mn-ct" aria-hidden="true">
          <kbd className="kbd">{keyText(keys)}</kbd>
        </span>
      )}
    </BaseMenu.Item>
  );
}

/** Holds the radio entries of which one is chosen. */
export function MenuRadioGroup<V extends string>({
  value,
  onChange,
  children,
}: {
  value: V;
  onChange: (value: V) => void;
  children: ReactNode;
}) {
  return (
    <BaseMenu.RadioGroup value={value} onValueChange={(next: V) => onChange(next)}>
      {children}
    </BaseMenu.RadioGroup>
  );
}

/** One choice of a radio group, ticked at the end while chosen. */
export function MenuRadioItem({
  value,
  icon,
  children,
}: {
  value: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <BaseMenu.RadioItem value={value} className="mn-row">
      <Slot icon={icon} />
      <span className="mn-tx">{children}</span>
      <BaseMenu.RadioItemIndicator className="mn-ck">
        <Check aria-hidden="true" />
      </BaseMenu.RadioItemIndicator>
    </BaseMenu.RadioItem>
  );
}

/** An entry that turns something on or off, ticked at the end while on. */
export function MenuCheckboxItem({
  checked,
  onChange,
  disabled,
  icon,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <BaseMenu.CheckboxItem
      checked={checked}
      disabled={disabled}
      onCheckedChange={(next) => onChange(next)}
      className="mn-row"
    >
      <Slot icon={icon} />
      <span className="mn-tx">{children}</span>
      <BaseMenu.CheckboxItemIndicator className="mn-ck">
        <Check aria-hidden="true" />
      </BaseMenu.CheckboxItemIndicator>
    </BaseMenu.CheckboxItem>
  );
}

export const MenuSeparator = () => <BaseMenu.Separator className="mn-sep" />;

/** Entries under a heading. */
export function MenuGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <BaseMenu.Group>
      <BaseMenu.GroupLabel className="mn-gh">{label}</BaseMenu.GroupLabel>
      {children}
    </BaseMenu.Group>
  );
}

/** An entry that opens a further menu beside it. */
export function SubMenu({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <BaseMenu.SubmenuRoot>
      <BaseMenu.SubmenuTrigger className="mn-row">
        <Slot icon={icon} />
        <span className="mn-tx">{label}</span>
        <ChevronRight className="mn-sub" aria-hidden="true" />
      </BaseMenu.SubmenuTrigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner style={{ zIndex: 60 }}>
          <BaseMenu.Popup
            className="mn mn-menu pop"
            aria-label={t({ id: 'menu.submenu', defaultMessage: '{label} submenu' }, { label })}
          >
            {children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.SubmenuRoot>
  );
}
