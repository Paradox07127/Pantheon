import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Monitor, Moon, Sun } from 'lucide-react';
import { t } from '../i18n';
import type { Theme } from '../store';

interface ThemeSwitchProps {
  value: Theme;
  onValueChange: (theme: Theme) => void;
  /** Names each choice in text instead of an icon. */
  withText?: boolean;
}

export function ThemeSwitch({ value, onValueChange, withText = false }: ThemeSwitchProps) {
  const light = t({ id: 'components.themeSwitch.light', defaultMessage: 'Light' });
  const dark = t({ id: 'components.themeSwitch.dark', defaultMessage: 'Dark' });
  const system = t({ id: 'components.themeSwitch.system', defaultMessage: 'Match system' });
  return (
    <RadioGroup<Theme>
      className="seg"
      aria-label={t({ id: 'components.themeSwitch.label', defaultMessage: 'Theme' })}
      value={value}
      onValueChange={(theme) => onValueChange(theme)}
    >
      <Radio.Root value="light" aria-label={withText ? undefined : light}>
        {withText ? light : <Sun aria-hidden="true" />}
      </Radio.Root>
      <Radio.Root value="dark" aria-label={withText ? undefined : dark}>
        {withText ? dark : <Moon aria-hidden="true" />}
      </Radio.Root>
      <Radio.Root value="system" aria-label={withText ? undefined : system}>
        {withText ? system : <Monitor aria-hidden="true" />}
      </Radio.Root>
    </RadioGroup>
  );
}
