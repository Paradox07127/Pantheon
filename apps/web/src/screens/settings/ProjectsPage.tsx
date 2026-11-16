import { useAppSettings } from '../../data/app-settings';
import { t } from '../../i18n';
import { Row } from './ProjectSettingsScreen';

/** Whether Pantheon runs git init in a folder it opens as a project; the same for every project. */
export function AutoGitInitRow() {
  const { settings, error, saving, save } = useAppSettings();
  const label = t({
    id: 'settings.projects.autoGitInit',
    defaultMessage: 'Automatic git init',
  });
  return (
    <>
      {settings && (
        <Row label={label} settingId="general.autoGitInit">
          <input
            type="checkbox"
            className="ps-sw"
            aria-label={label}
            checked={settings.auto_git_init}
            disabled={saving}
            onChange={(e) => void save({ auto_git_init: e.target.checked })}
          />
        </Row>
      )}
      {error !== null && (
        <div className="ps-err gp-err" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
