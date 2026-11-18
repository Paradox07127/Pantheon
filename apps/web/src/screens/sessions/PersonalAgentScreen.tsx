import type { CSSProperties } from 'react';
import { Globe, IdCard } from 'lucide-react';
import { SessionStateIcon, StateGlyph } from '../../components/SessionStateIcon';
import { Tip } from '../../components/Tip';
import { useBoard } from '../../data/board';
import type { NeedsYouState } from '../../data/needs-you';
import {
  personalSessionOf,
  showPersonalProfile,
  usePersonalProfileShown,
} from '../../data/personal-agent';
import type { useSessionList } from '../../data/workbench-sessions';
import { t } from '../../i18n';
import { SCREEN_NAMES } from '../../screens';
import type { Panel } from './inspector-model';
import { PersonalAgentProfile } from './PersonalAgentProfile';
import { Thread } from './Thread';

const NO_PANELS: readonly Panel[] = [];

/** The personal agent's conversation: its bar, thread and composer, with no project's branch, panels or terminal. */
export function PersonalAgentScreen({
  needs,
  list,
}: {
  needs: NeedsYouState;
  /** The home project's sessions. */
  list: ReturnType<typeof useSessionList>;
}) {
  const board = useBoard((s) => s.board);
  const listed = personalSessionOf(list.data ?? []);
  const name = SCREEN_NAMES.personal;
  const profile = usePersonalProfileShown();
  const profileLabel = t({ id: 'components.sidebar.agentProfile', defaultMessage: 'Profile' });
  const head = (
    <header className="sh-bar">
      {listed ? (
        <SessionStateIcon session={listed} place="header" />
      ) : (
        <StateGlyph name="starting" place="header" />
      )}
      <h1 className="sh-title">{name}</h1>
      <span className="chip">
        <Globe className="ic-sm" aria-hidden="true" />
        {t({ id: 'sessions.residents.allProjects', defaultMessage: 'All projects' })}
      </span>
      <span className="sh-fill" />
      <Tip content={profileLabel}>
        <button
          type="button"
          className="ib"
          aria-label={profileLabel}
          aria-pressed={profile}
          onClick={() => showPersonalProfile(!profile)}
        >
          <IdCard aria-hidden="true" />
        </button>
      </Tip>
    </header>
  );
  return (
    <div
      className={profile ? 'ss' : 'ss ss-np'}
      style={profile ? ({ '--ss-pw': `${PROFILE_WIDTH}px` } as CSSProperties) : undefined}
    >
      <main
        className="ss-convo"
        aria-label={t({ id: 'sessions.screen.conversation', defaultMessage: 'Conversation' })}
        data-docked={profile ? '' : undefined}
      >
        {board && listed ? (
          <section className="sp-pane">
            <Thread
              key={listed.id}
              board={board}
              sessionId={listed.id}
              // The daemon's title is the profile's English name; the bar and composer show the app's.
              listed={{ ...listed, title: name }}
              needs={needs}
              parent={null}
              panels={NO_PANELS}
              onPanel={() => {}}
              overview={false}
              onDiscarded={() => {}}
              head={head}
            />
          </section>
        ) : (
          <>
            {head}
            <div className="ss-fill" aria-busy="true" />
          </>
        )}
      </main>
      {profile && (
        <aside
          className="ss-dock"
          aria-label={t({ id: 'sessions.header.panels', defaultMessage: 'Panels' })}
        >
          <PersonalAgentProfile runtime={listed?.runtime ?? null} />
        </aside>
      )}
    </div>
  );
}

/** The profile's width, the same as a project agent's. */
const PROFILE_WIDTH = 400;
