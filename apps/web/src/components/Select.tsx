import { Select as BaseSelect } from '@base-ui/react/select';
import { Check, ChevronDown } from 'lucide-react';
import './menu.css';

/** A choice of one of `options`, listed in the menu's rows; `onChange` hears only a new value. */
export function Select<V extends string>({
  value,
  onChange,
  options,
  'aria-label': label,
  'aria-invalid': invalid,
  disabled,
}: {
  value: V;
  onChange: (value: V) => void;
  options: { value: V; label: string }[];
  'aria-label': string;
  'aria-invalid'?: boolean;
  disabled?: boolean;
}) {
  return (
    <BaseSelect.Root<V>
      items={options}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null && next !== value) onChange(next);
      }}
    >
      <BaseSelect.Trigger className="mn-sel" aria-label={label} aria-invalid={invalid}>
        <BaseSelect.Value />
        <BaseSelect.Icon className="mn-sel-ic">
          <ChevronDown aria-hidden="true" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          side="bottom"
          sideOffset={4}
          alignItemWithTrigger={false}
          style={{ zIndex: 60 }}
        >
          <BaseSelect.Popup className="mn mn-list pop">
            <BaseSelect.List>
              {options.map((o) => (
                <BaseSelect.Item
                  key={o.value}
                  value={o.value}
                  data-value={o.value}
                  className="mn-row"
                >
                  <BaseSelect.ItemText className="mn-tx">{o.label}</BaseSelect.ItemText>
                  <BaseSelect.ItemIndicator className="mn-ck">
                    <Check aria-hidden="true" />
                  </BaseSelect.ItemIndicator>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
