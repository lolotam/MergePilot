import { useState } from 'react';
import { Copy, Trash2 } from 'lucide-react';
import type { FallbackEntry } from '@mergepilot/app/contract';
import {
  useDeleteBotMutation,
  useSaveBotMutation,
  type BotLogo,
  type ReviewerBotDto,
  type ReviewerBotInput,
} from '../../api/bots.js';
import { ApiClientError, type ApiProvider } from '../../api/client.js';
import { Modal } from '../../components/Modal.js';
import { useToast } from '../../components/Toast.js';
import { useI18n } from '../../i18n/context.js';
import { EffortSelect, effortFor } from '../EffortSelect.js';
import { FallbackModelsCard } from '../FallbackModelsCard.js';
import { ModelSelect } from '../ModelSelect.js';
import { ProviderSelect, useModelEfforts } from '../providers.js';
import { SkillSelect } from '../skills/SkillSelect.js';
import { BotIdentityFields } from './BotIdentityFields.js';
import { botNameError, sameBotName } from './BotLogo.js';

/** The main bot's model, copied into an extra bot by "Copy from main bot". */
export interface MainBotModel {
  provider: ApiProvider | null;
  model: string | null;
  effort: string | null;
  fallback: FallbackEntry[];
}

export interface ExtraBotCardProps {
  workspaceId: string;
  bot: ReviewerBotDto;
  main: MainBotModel;
  /** Every other bot's name (the main bot's too): names are unique in the workspace. */
  otherNames: readonly string[];
  keyedProviders?: readonly ApiProvider[] | undefined;
  isMember: boolean;
  onDeleted: () => void;
}

type Errors = Partial<Record<'name' | 'model' | 'fallback' | 'skill' | 'form', string>>;

const cleanFallback = (list: readonly FallbackEntry[]): FallbackEntry[] =>
  list.map((f) => ({ provider: f.provider, model: f.model.trim(), effort: f.effort ?? null }));

/** The saved bot as a PUT body, with `active` changed (the switch saves at once). */
const savedInput = (bot: ReviewerBotDto, active: boolean, exploreEnabled = bot.exploreEnabled): ReviewerBotInput => ({
  name: bot.name,
  logo: bot.logo,
  active,
  provider: bot.provider,
  model: bot.model,
  effort: bot.effort,
  fallback: bot.fallback,
  exploreEnabled,
});

const secondaryButton =
  'inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-semibold border transition-colors disabled:opacity-50 focus:ring-2 focus:outline-hidden';

/** One extra bot's tab (slots 2-5): identity, model, effort and fallback; no heavy model. */
export function ExtraBotCard({ workspaceId, bot, main, otherNames, keyedProviders, isMember, onDeleted }: ExtraBotCardProps) {
  const { t } = useI18n();
  const { showToast } = useToast();
  const save = useSaveBotMutation(workspaceId);
  const remove = useDeleteBotMutation(workspaceId);
  const [name, setName] = useState(bot.name);
  const [logo, setLogo] = useState<BotLogo>(bot.logo);
  const [provider, setProvider] = useState<ApiProvider>(bot.provider);
  const [model, setModel] = useState(bot.model);
  const [effort, setEffort] = useState<string | null>(bot.effort);
  const [fallback, setFallback] = useState<FallbackEntry[]>(bot.fallback);
  // The bot's review skill (ADR-0034); null = Default. Follows the server when it changes there
  // (deleting a skill sets its bots to Default).
  const savedSkillId = bot.skillId ?? null;
  const [skillId, setSkillId] = useState<string | null>(savedSkillId);
  const [shownSkillId, setShownSkillId] = useState<string | null>(savedSkillId);
  if (shownSkillId !== savedSkillId) {
    setShownSkillId(savedSkillId);
    setSkillId(savedSkillId);
  }
  const [errors, setErrors] = useState<Errors>({});
  const [copied, setCopied] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const efforts = useModelEfforts(workspaceId, provider, model);
  const prefix = `bot-${bot.slot}`;
  const clear = (field: keyof Errors) => {
    if (errors[field]) setErrors(({ [field]: _gone, ...rest }) => rest);
  };

  const serverError = (err: unknown): Errors => {
    const code = err instanceof ApiClientError ? err.code : undefined;
    if (code === 'bot_name_taken') return { name: t('botNameTaken') };
    if (code === 'fallback_duplicate') return { fallback: t('botFallbackDuplicate') };
    if (code === 'fallback_key_missing') return { fallback: t('botFallbackKeyMissing') };
    if (code === 'unknown_skill') return { skill: t('skillErrorUnknown') };
    const message = err instanceof Error && err.message ? err.message : t('error');
    return { form: t('botSaveFailed', { message }) };
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isMember) return;
    const next: Errors = {};
    const nameProblem = botNameError(name);
    if (nameProblem) next.name = t(nameProblem);
    else if (otherNames.some((other) => sameBotName(other, name))) next.name = t('botNameTaken');
    if (!model.trim()) next.model = t('modelRequired');
    if (fallback.some((f) => !f.model.trim())) next.fallback = t('fallbackModelRequired');
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const input: ReviewerBotInput = {
      name: name.trim(),
      logo,
      active: bot.active,
      provider,
      model: model.trim(),
      effort,
      fallback: cleanFallback(fallback),
      // Always sent: saving the bot confirms the skill choice and clears a deleted-skill note.
      skillId,
      exploreEnabled: bot.exploreEnabled,
    };
    try {
      await save.mutateAsync({ slot: bot.slot, input });
      setCopied(false);
      showToast(t('botSaved'), 'success');
    } catch (err) {
      setErrors(serverError(err));
    }
  };

  const toggleActive = async (active: boolean) => {
    try {
      await save.mutateAsync({ slot: bot.slot, input: savedInput(bot, active) });
      showToast(t('botSaved'), 'success');
    } catch (err) {
      showToast(err instanceof Error && err.message ? err.message : t('error'), 'error');
    }
  };

  const toggleExplore = async (exploreEnabled: boolean) => {
    try {
      await save.mutateAsync({ slot: bot.slot, input: savedInput(bot, bot.active, exploreEnabled) });
      showToast(t('botSaved'), 'success');
    } catch (err) {
      showToast(err instanceof Error && err.message ? err.message : t('error'), 'error');
    }
  };

  const copyFromMain = () => {
    if (!main.provider || !main.model) return;
    setProvider(main.provider);
    setModel(main.model);
    setEffort(main.effort);
    setFallback(main.fallback.map((f) => ({ ...f })));
    setErrors({});
    setCopied(true);
  };

  const confirmDelete = async () => {
    try {
      await remove.mutateAsync(bot.slot);
      setConfirmOpen(false);
      showToast(t('botDeleted'), 'success');
      onDeleted();
    } catch (err) {
      setConfirmOpen(false);
      showToast(err instanceof Error && err.message ? err.message : t('error'), 'error');
    }
  };

  return (
    <div className="p-4 sm:p-6 bg-white dark:bg-ink-900 rounded-[10px] border border-ink-200 dark:border-ink-700 shadow-xs flex flex-col gap-6">
      <p className="text-xs text-ink-500 dark:text-ink-400 leading-relaxed">{t('botExtraDesc')}</p>
      <form onSubmit={handleSave} className="flex flex-col gap-6" noValidate>
        <BotIdentityFields
          idPrefix={prefix}
          name={name}
          onNameChange={(next) => {
            setName(next);
            clear('name');
          }}
          logo={logo}
          onLogoChange={setLogo}
          active={bot.active}
          onActiveChange={(next) => void toggleActive(next)}
          activeBusy={save.isPending}
          disabled={isMember}
          nameError={errors.name}
        />

        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3">
            <button
              type="button"
              role="switch"
              aria-checked={bot.exploreEnabled}
              aria-label={t('botExploreLabel')}
              aria-describedby={`${prefix}-explore-hint`}
              disabled={isMember || save.isPending}
              onClick={() => void toggleExplore(!bot.exploreEnabled)}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-60 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 ${bot.exploreEnabled ? 'bg-green-500' : 'bg-ink-300 dark:bg-ink-700'}`}
            >
              <span aria-hidden="true" className={`absolute top-0.5 start-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${bot.exploreEnabled ? 'translate-x-4 rtl:-translate-x-4' : ''}`} />
            </button>
            <span className="text-xs font-semibold text-ink-800 dark:text-ink-200">{t('botExploreLabel')}</span>
          </div>
          <p id={`${prefix}-explore-hint`} className="text-[11px] text-ink-500 dark:text-ink-400 ms-12">{t('botExploreHint')}</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <ProviderSelect
            id={`${prefix}-provider`}
            workspaceId={workspaceId}
            label={t('providerLabel')}
            value={provider}
            options={keyedProviders}
            disabled={isMember}
            onChange={(next) => {
              setProvider(next);
              setModel('');
              setEffort(null);
            }}
          />
          <div>
            <ModelSelect
              id={`${prefix}-model`}
              workspaceId={workspaceId}
              provider={provider}
              value={model}
              disabled={isMember}
              onChange={(m, modelEfforts) => {
                setModel(m);
                setEffort((current) => effortFor(modelEfforts, current));
                clear('model');
              }}
            />
            {errors.model && <p className="text-xs text-red-500 mt-1 ms-2">{errors.model}</p>}
          </div>
          <EffortSelect id={`${prefix}-effort`} efforts={efforts} value={effort} onChange={setEffort} disabled={isMember} />
          <div>
            <SkillSelect
              id={`${prefix}-skill`}
              workspaceId={workspaceId}
              value={skillId}
              onChange={(next) => {
                setSkillId(next);
                clear('skill');
              }}
              disabled={isMember}
              removedName={bot.skillId ? null : bot.skillRemovedName}
            />
            {errors.skill && <p className="text-xs text-red-500 mt-1 ms-2">{errors.skill}</p>}
          </div>
        </div>
        <p className="text-[11px] text-ink-500 dark:text-ink-400 -mt-3 ms-1">{t('botNoHeavyHint')}</p>

        <FallbackModelsCard
          idPrefix={`${prefix}-fallback`}
          workspaceId={workspaceId}
          fallbacks={fallback}
          onChange={(next) => {
            setFallback(next);
            clear('fallback');
          }}
          providers={keyedProviders}
          disabled={isMember}
          error={errors.fallback}
        />

        {copied && <p role="status" className="text-xs text-brand-700 dark:text-brand-300">{t('botCopiedHint')}</p>}
        {errors.form && <p role="alert" className="text-xs text-red-500">{errors.form}</p>}

        {!isMember && (
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-ink-100 dark:border-ink-800">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={copyFromMain}
                disabled={!main.provider || !main.model}
                className={`${secondaryButton} bg-brand-50 hover:bg-brand-100 dark:bg-brand-950/40 dark:hover:bg-brand-950/80 text-brand-700 dark:text-brand-300 border-brand-200 dark:border-brand-800 focus:ring-brand-500`}
              >
                <Copy className="w-3.5 h-3.5" />
                {t('botCopyFromMain')}
              </button>
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                className={`${secondaryButton} text-red-600 border-red-200 dark:border-red-900 hover:bg-red-50 dark:hover:bg-red-950/50 focus:ring-red-500`}
              >
                <Trash2 className="w-3.5 h-3.5" />
                {t('botDeleteButton')}
              </button>
            </div>
            <button
              type="submit"
              disabled={save.isPending}
              className="px-5 py-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white font-medium rounded-full text-xs transition-colors focus:ring-2 focus:ring-brand-500 focus:outline-hidden"
            >
              {save.isPending ? t('saving') : t('botSaveButton')}
            </button>
          </div>
        )}
      </form>

      <Modal
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t('botDeleteTitle', { name: bot.name })}
        description={t('botDeleteDesc')}
      >
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setConfirmOpen(false)}
            className="px-4 py-2 rounded-full text-xs font-semibold text-ink-700 dark:text-ink-200 hover:bg-ink-100 dark:hover:bg-ink-800"
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            onClick={() => void confirmDelete()}
            disabled={remove.isPending}
            className="px-4 py-2 rounded-full text-xs font-semibold bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
          >
            {t('delete')}
          </button>
        </div>
      </Modal>
    </div>
  );
}
