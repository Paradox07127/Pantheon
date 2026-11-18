import {
  Bot,
  Eye,
  Flag,
  Gauge,
  Globe,
  KeyRound,
  MessageSquare,
  Route,
  User,
  Workflow,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { PersonalAnswerKind } from '@pantheon/protocol';
import { RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { useAgents } from '../../data/agents';
import { useAppSettings } from '../../data/app-settings';
import { useBoard } from '../../data/board';
import {
  personalHomeOf,
  revokePersonalKey,
  showPersonalProfile,
  usePersonalKeys,
} from '../../data/personal-agent';
import { visibleProjects } from '../../data/projects';
import { t } from '../../i18n';
import { dayText } from '../../lib/time-text';
import { SCREEN_NAMES } from '../../screens';

const NO_PROJECTS: readonly never[] = [];

/** The personal agent's profile beside its conversation: what it may do, answer and read with. */
export function PersonalAgentProfile({ runtime }: { runtime: string | null }) {
  const projects = useBoard((s) => s.board?.projects ?? NO_PROJECTS);
  const home = personalHomeOf(projects);
  const builtIn = useAgents(home?.id ?? null)?.find(
    (agent) => agent.template === 'personal',
  )?.personal_key_id;
  const { settings, error, saving, save } = useAppSettings();
  const keys = usePersonalKeys();
  const name = SCREEN_NAMES.personal;
  const answers: { kind: PersonalAnswerKind; icon: LucideIcon; label: string }[] = [
    {
      kind: 'question',
      icon: MessageSquare,
      label: t({ id: 'sessions.personalAgent.answer.question', defaultMessage: 'Questions' }),
    },
    {
      kind: 'plan_change',
      icon: Workflow,
      label: t({ id: 'sessions.personalAgent.answer.planChange', defaultMessage: 'Plan changes' }),
    },
    {
      kind: 'milestone_accept',
      icon: Flag,
      label: t({
        id: 'sessions.personalAgent.answer.milestone',
        defaultMessage: 'Milestone acceptance',
      }),
    },
  ];
  const yours: { icon: LucideIcon; label: string }[] = [
    {
      icon: KeyRound,
      label: t({ id: 'sessions.personalAgent.yours.permissions', defaultMessage: 'Permissions' }),
    },
    {
      icon: Bot,
      label: t({ id: 'sessions.personalAgent.yours.agents', defaultMessage: 'New agents' }),
    },
    {
      icon: Zap,
      label: t({ id: 'sessions.personalAgent.yours.external', defaultMessage: 'External events' }),
    },
    {
      icon: Gauge,
      label: t({ id: 'sessions.personalAgent.yours.budget', defaultMessage: 'Budget' }),
    },
    {
      icon: MessageSquare,
      label: t({
        id: 'sessions.personalAgent.yours.workerQuestions',
        defaultMessage: 'Worker questions',
      }),
    },
  ];
  const cannot = t({ id: 'sessions.personalAgent.cannot', defaultMessage: 'Cannot' });
  const on = settings?.personal_answers ?? [];
  return (
    <aside className="ag-insp" aria-labelledby="pa-title">
      <div className="ag-ih">
        <User aria-hidden="true" />
        <h2 id="pa-title">{name}</h2>
        <button
          type="button"
          className="ib ag-end"
          aria-label={t({ id: 'sessions.agents.profile.close', defaultMessage: 'Close profile' })}
          onClick={() => showPersonalProfile(false)}
        >
          <X aria-hidden="true" />
        </button>
      </div>
      <div className="ag-ib">
        <div className="pa-meta">
          <span className="chip">
            <Globe className="ic-sm" aria-hidden="true" />
            {t({ id: 'sessions.residents.allProjects', defaultMessage: 'All projects' })}
          </span>
          {runtime && (
            <span className="pa-rt">
              <RuntimeGlyph runtime={runtime} size={14} />
              {runtimeName(runtime)}
            </span>
          )}
        </div>
        <section
          className="ag-sec"
          aria-label={t({ id: 'sessions.personalAgent.can', defaultMessage: 'What it can do' })}
        >
          <ul className="pa-cl">
            <li>
              <Eye className="ag-li" aria-hidden="true" />
              <span>
                {t({ id: 'sessions.personalAgent.can.read', defaultMessage: 'Read every project' })}
              </span>
              <span className="pa-n">
                {t(
                  {
                    id: 'sessions.personalAgent.can.projects',
                    defaultMessage: '{count, plural, one {# project} other {# projects}}',
                  },
                  { count: visibleProjects(projects).length },
                )}
              </span>
            </li>
            <li>
              <Route className="ag-li" aria-hidden="true" />
              <span>
                {t({
                  id: 'sessions.personalAgent.can.request',
                  defaultMessage: 'Send requests to a project’s Assistant',
                })}
              </span>
            </li>
            <li className="pa-no">
              <X className="ag-li" role="img" aria-label={cannot} />
              <span>
                {t({
                  id: 'sessions.personalAgent.cannot.workers',
                  defaultMessage: 'Start workers',
                })}
              </span>
            </li>
            <li className="pa-no">
              <X className="ag-li" role="img" aria-label={cannot} />
              <span>
                {t({
                  id: 'sessions.personalAgent.cannot.plans',
                  defaultMessage: 'Read whole plans',
                })}
              </span>
            </li>
          </ul>
        </section>
        <section className="ag-sec" aria-labelledby="pa-ans" aria-busy={!settings || undefined}>
          <span className="cap" id="pa-ans">
            {t({ id: 'sessions.personalAgent.answers', defaultMessage: 'Answers for you' })}
          </span>
          <ul className="pa-cl">
            {answers.map(({ kind, icon: Icon, label }) => (
              <li key={kind}>
                <Icon className="ag-li" aria-hidden="true" />
                <label htmlFor={`pa-${kind}`}>{label}</label>
                <input
                  id={`pa-${kind}`}
                  type="checkbox"
                  role="switch"
                  className="ps-sw"
                  checked={on.includes(kind)}
                  disabled={!settings || saving}
                  onChange={(e) =>
                    void save({
                      personal_answers: answers
                        .map((each) => each.kind)
                        .filter((each) => (each === kind ? e.target.checked : on.includes(each))),
                    })
                  }
                />
              </li>
            ))}
          </ul>
          {error && (
            <p className="ag-err" role="alert">
              {error}
            </p>
          )}
        </section>
        <section className="ag-sec" aria-labelledby="pa-yours">
          <span className="cap" id="pa-yours">
            {t({ id: 'sessions.personalAgent.yours', defaultMessage: 'Always asks you' })}
          </span>
          <ul className="pa-cl">
            {yours.map(({ icon: Icon, label }) => (
              <li key={label} className="pa-no">
                <Icon className="ag-li" aria-hidden="true" />
                <span>{label}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="ag-sec" aria-labelledby="pa-key" aria-busy={keys.loading || undefined}>
          <span className="cap" id="pa-key">
            {t({ id: 'sessions.personalAgent.keys', defaultMessage: 'Personal agent key' })}
          </span>
          {keys.error && (
            <p className="ag-err" role="alert">
              {keys.error}
            </p>
          )}
          <ul className="pa-cl">
            {(keys.data ?? []).map((key) => (
              <li key={key.id}>
                <KeyRound className="ag-li" aria-hidden="true" />
                <span className="pa-key">
                  <span>
                    {key.id === builtIn
                      ? t({
                          id: 'sessions.personalAgent.keys.builtIn',
                          defaultMessage: 'Built-in personal agent',
                        })
                      : key.label}
                  </span>
                  <span className="pa-n">{dayText(key.created_at, Date.now())}</span>
                </span>
                {key.revoked_at ? (
                  <span className="pa-n">
                    {t({ id: 'sessions.personalAgent.keys.revoked', defaultMessage: 'Revoked' })}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn sm dng"
                    aria-describedby={key.id === builtIn ? 'pa-built-in' : undefined}
                    onClick={() => void revokePersonalKey(key.id).then((ok) => ok && keys.reload())}
                  >
                    {t({ id: 'sessions.personalAgent.keys.revoke', defaultMessage: 'Revoke' })}
                  </button>
                )}
                {key.id === builtIn && !key.revoked_at && (
                  <p className="pa-warn" id="pa-built-in">
                    {t({
                      id: 'sessions.personalAgent.keys.builtInRevoke',
                      defaultMessage:
                        'After you revoke it, the personal agent cannot read your projects and is not woken; it gets a new key when you open it again.',
                    })}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </aside>
  );
}
