import { reviewKey, type ReviewDraft, type RevisionPin } from '../../suggestions.ts';
import { useReviewSelection } from '../review-selection.ts';
import type { PaperMode } from '../paper-projection.ts';
import { breakpoints, printLayout } from '../../style-tokens.ts';
import { profileFor, type DocumentType, type PageStyle } from '../../document-profile.ts';
import type { BlockQuote } from '../../quotes.ts';
import { naturalParagraphs } from '../../paragraphs.ts';
import { numberedTitles } from '../../numbering.ts';
import { checkReferences } from '../../references.ts';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { flatten, type MindNode, type Operation, type Expansion } from '../../model.ts';
import { type Numbering, type ArticleTitle } from '../../format.ts';
import { documentCopy, type CopyKey } from '../../locales.ts';
import { nodeTitleParts, type MapCardSource } from '../map-card.ts';
import { ancestors } from '../navigation.ts';
import { documentKey } from '../types.ts';
import type { Snapshot, State, EditorProps, Draft } from '../types.ts';
import { OperationQueue } from '../operation-queue.ts';
import { useNavigation, type EditorView } from './useNavigation.ts';
import type { exportCheck } from '../../export-check.ts';
import {
  DraftRepository,
  editDraft,
  mergeDraft,
  acknowledgeDraft,
  type FieldConflict,
} from '../drafts.ts';
import {
  defaultPreferences,
  readPreferences,
  writePreferences,
  type DocumentPreferences,
} from '../preferences.ts';
import { healthy, pollFailed, retryDelay } from '../poll-health.ts';
import { composing, nodeCommand } from '../keyboard.ts';
import { headingIndex, projectHeading, type NewHeading } from '../new-heading.ts';
import { useOnboarding } from '../onboarding.ts';
import {
  parsePaste,
  cleanPasteText,
  type PastePreview,
  type PasteCommand,
  type PasteTarget,
  type PasteReceipt,
  pasteTextLimit,
} from '../../paste-tree.ts';
import { paragraphAnchor, type ReadingAnchor } from '../reading.ts';
import { copiedNodeTitle } from '../node-clipboard.ts';
import type { RevisionRow } from '../../revisions.ts';
import type { ReviewedBatch, ReviewReceipt, SuggestionEdit } from '../../suggestions.ts';
import { cleanFilename } from '../../filenames.ts';
import {
  aiTargets,
  actionTargetIds,
  instructionForSelection,
  writingInstruction,
  type AiTargets,
  type WritingAction,
} from '../instruction.ts';

type ExportCheck = ReturnType<typeof exportCheck> & {
  token: string;
  suggestionToken: string;
  pendingCount: number;
};
type ExportFormat = 'docx' | 'md' | 'text';
type SidebarTarget = { path: string; documentId?: string };
type DocumentSwitch = { pendingSidebar?: SidebarTarget };
type PastePlace = PasteTarget & { name: string; preamble: boolean; reading?: ReadingAnchor };
type PasteFeedback = { at: PastePlace; token: string } & (
  | { stage: 'done'; receipt: PasteReceipt }
  | {
      stage: 'review';
      command: PasteCommand;
      replace?: string;
      consent: string;
      key: string;
      count: number;
    }
  | { stage: 'section'; text: string }
  | { stage: 'keyboard'; view: EditorView }
);
type PasteResult =
  | { snapshot: Snapshot; receipt?: PasteReceipt }
  | {
      pending: { suggestions: ReviewedBatch[]; key: string; consent: string; count: number };
    };

function selectedAutoTitles(rows: ReturnType<typeof flatten>, selection: string[]) {
  const selected = new Set(selection);
  return rows
    .filter(({ node }) => selected.has(node.id) && node.titleSource === 'auto')
    .map(({ node }) => node.id);
}

export function useEditor({
  sessionId,
  useTabInfo,
  request,
  initialLanguage,
  languageSource,
}: EditorProps) {
  const { tab } = useTabInfo();
  const hostLanguage = useSyncExternalStore(languageSource.subscribe, languageSource.get);
  const [language, setLanguage] = useState(initialLanguage);
  useEffect(() => setLanguage(hostLanguage), [hostLanguage]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const snapRef = useRef(snapshot);

  const [files, setFiles] = useState<State['files']>([]);
  const [locked, setLocked] = useState(false);
  const [recentAdoption, setRecentAdoption] = useState<string[]>([]);
  const [activeIds, setActiveIds] = useState<string[]>([]);
  const [queueNotice, setQueueNotice] = useState<string | null>(null);
  const [integrityAlert, setIntegrityAlert] = useState<State['alert']>(null);
  const [drawer, setDrawer] = useState<
    | 'edit'
    | 'actions'
    | 'export'
    | 'conflicts'
    | 'writing-actions'
    | 'chapter-selection'
    | 'profile'
    | 'settings'
    | 'ai-history'
    | 'health'
    | 'help'
    | 'ai-review'
    | 'paste'
    | 'export-formats'
    | 'revisions'
    | null
  >(null);
  const [menu, setMenu] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [outlineEditing, setOutlineEditing] = useState<string>();
  const [exportReview, setExportReview] = useState<(ExportCheck & { format: ExportFormat }) | null>(
    null,
  );
  const anchor = useRef<string>();
  const [diagnostics, setDiagnosticsState] = useState<'import' | 'references' | null>(null);
  const [error, setError] = useState('');
  const [errorDetails, setErrorDetails] = useState('');
  const [exportFilename, setExportFilename] = useState('');
  const [suggestions, setSuggestions] = useState<ReviewedBatch[]>([]);
  const [paperMode, setPaperMode] = useState<PaperMode>('markup');
  const [reviewDrafts, setReviewDrafts] = useState<ReviewDraft[]>([]);
  const [reviewRequest, setReviewRequest] = useState<{ key: string; digest: string }>();
  const [revising, setRevising] = useState<string[]>([]);
  const knownDrafts = useRef<string>();
  const knownSuggestions = useRef<string>();
  const [expansion, setExpansion] = useState<Expansion>('one');
  const [startAction, setStartAction] = useState<'structure' | 'paste' | 'new' | 'manual'>('new');
  const stateEpoch = useRef(0);
  const documentEpoch = useRef(0);
  const switching = useRef<DocumentSwitch>();
  const renderEpoch = documentEpoch.current;
  const lastSidebarRead = useRef(0);
  const [pasteText, setPasteText] = useState('');
  const [pastePreview, setPastePreview] = useState<PastePreview | null>(null);
  const [pasteFeedback, setPasteFeedback] = useState<PasteFeedback>();
  const [clipboardBlocked, setClipboardBlocked] = useState(false);
  useEffect(() => {
    let active = true;
    let permission: PermissionStatus | undefined;
    const update = () => setClipboardBlocked(permission?.state === 'denied');
    void navigator.permissions
      ?.query({ name: 'clipboard-read' as PermissionName })
      .then((status) => {
        if (!active) return;
        permission = status;
        if (status.state === 'denied') update();
        status.addEventListener('change', update);
      })
      .catch(() => {});
    return () => {
      active = false;
      permission?.removeEventListener('change', update);
    };
  }, []);
  const [onlyChanges, setOnlyChanges] = useState(false);
  const [revisionData, setRevisionData] = useState<{
    rows: RevisionRow[];
    token: string;
    hasSource: boolean;
  } | null>(null);
  const [pollHealth, setPollHealth] = useState(healthy);
  const pollHealthRef = useRef(healthy);
  const [loaded, setLoaded] = useState(false);
  const [localError, setLocalError] = useState('');
  const [recovery, setRecoveryState] = useState<Draft | null>(null);
  const recoveryRef = useRef<Draft | null>(null);
  function setRecovery(value: Draft | null) {
    recoveryRef.current = value;
    setRecoveryState(value);
  }
  const mounted = useRef(true);
  const [conflicts, setConflicts] = useState<FieldConflict[]>([]);
  const conflictSnapshot = useRef<Snapshot>();
  const composingNodes = useRef(new Set<string>());
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [instructionDraft, setInstructionDraft] = useState({ key: '', text: '' });
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [preferences, setPreferences] = useState(defaultPreferences);
  const preferencesRef = useRef(preferences);
  const { articleTitle, fontSize, arabic } = preferences;
  const profile = profileFor(snapshot ?? {}, preferences.scheme);
  const t = (key: CopyKey) => documentCopy(language, profile.type, key);
  const scheme = profile.scheme;
  const pageStyle = preferences.layout ?? profile.layout;
  const [editing, setEditing] = useState<string>();
  const [newHeading, setNewHeading] = useState<NewHeading>();
  const headingText = useRef('');
  const adding = useRef<NewHeading>();
  const submittingHeading = useRef<NewHeading>();
  const starting = useRef(false);
  const [inlineEdit, setInlineEdit] = useState<{
    id: string;
    title: string;
    body: string;
    path: string;
    documentId: string;
    fragment?: string;
    draftTitle?: string;
    draftBody?: string;
    view: EditorView;
  }>();
  function beginInlineEdit(
    node: MindNode,
    fragment?: string,
    destination = view,
    selectNode = true,
  ) {
    if (!snapshot || locked || recovery) return;
    setPasteFeedback(undefined);
    setEditing(undefined);
    if (selectNode) setSelection([node.id]);
    openDrawer(null);
    if (destination !== view) {
      navigation.reveal(node.id);
      setView(destination);
      locateSelection(node.id);
    }
    setInlineEdit({
      view: destination,
      id: node.id,
      path: snapshot.path,
      fragment,
      documentId: snapshot.id,
      title: value(node, 'title'),
      body: value(node, 'body'),
    });
  }
  async function saveInline(title: string, body: string) {
    const base = inlineEdit;
    if (!base) return;
    await structureChange((root) => {
      const current = flatten(root).find((row) => row.node.id === base.id)?.node;
      if (!current || snapRef.current?.path !== base.path || snapRef.current.id !== base.documentId)
        throw new Error(t('conflictChangedAgain'));
      const patch: Partial<Pick<MindNode, 'title' | 'body'>> = {};
      for (const field of ['title', 'body'] as const) {
        const next = field === 'title' ? title : body;
        if (next === base[field] || next === current[field]) continue;
        if (base[field] !== current[field]) throw new Error(t('conflictChangedAgain'));
        patch[field] = next;
      }
      return Object.keys(patch).length ? [{ type: 'update', id: base.id, ...patch }] : [];
    });
    setInlineEdit((active) => (active === base ? undefined : active));
  }
  const [draftVersion, refreshDraft] = useState(0);
  const draft = useRef<Draft | null>(null);
  function repository() {
    return new DraftRepository(localStorage);
  }
  function persistDraft() {
    const id = draft.current?.documentId ?? snapRef.current?.id;
    if (!id) return;
    try {
      repository().save(id, draft.current, draft.current?.path ?? snapRef.current?.path);
      setLocalError('');
    } catch {
      setLocalError(t('draftStorageError'));
    }
  }
  function updatePreferences(update: Partial<DocumentPreferences>) {
    const next = { ...preferencesRef.current, ...update };
    preferencesRef.current = next;
    setPreferences(next);
    try {
      if (snapRef.current) writePreferences(localStorage, documentKey(snapRef.current), next);
    } catch {
      setLocalError(t('preferencesError'));
    }
  }
  const setScheme = (scheme: Numbering) => {
    if (profile.legacy) updatePreferences({ scheme });
    else void perform(() => setDocumentProfile(profile.type, scheme, pageStyle));
  };
  const setArticleTitle = (articleTitle: ArticleTitle) => updatePreferences({ articleTitle });
  const setFontSize = (fontSize: number) =>
    updatePreferences({
      fontSize:
        fontSize === printLayout.official.smallBodyPt
          ? printLayout.official.smallBodyPt
          : printLayout.official.bodyPt,
    });
  const setArabic = (arabic: boolean) => updatePreferences({ arabic });
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const saving = useRef<Promise<void>>();
  const operations = useRef(new OperationQueue());
  const busyActions = useRef(0);
  const pathRef = useRef<string>();
  const editorElement = useRef<HTMLElement>(null);
  const treeFocus = useRef<{ documentId: string; id: string }>();
  const focusRequest = useRef(0);
  const inputFile = useRef<HTMLInputElement>(null);
  const dragId = useRef<string>();
  const [drop, setDrop] = useState<{ id: string; zone: 'before' | 'inside' | 'after' }>();
  const rows = useMemo(() => (snapshot ? flatten(snapshot.root) : []), [snapshot?.root]);
  const displayRoot = useMemo(
    () =>
      snapshot && newHeading?.owner === documentKey(snapshot)
        ? projectHeading(snapshot.root, newHeading)
        : snapshot?.root,
    [snapshot?.root, newHeading],
  );
  const review = useReviewSelection(suggestions, rows, documentKey(snapshot));
  const numbers = useMemo(
    () =>
      displayRoot
        ? numberedTitles(
            displayRoot,
            { ...profile, scheme: profile.legacy ? 'official' : scheme },
            profile.legacy && arabic,
          )
        : new Map<string, import('../../numbering.ts').NumberedTitle>(),
    [displayRoot, profile.legacy, profile.matchPosition, profile.prefixes, scheme, arabic],
  );
  const statuses = useMemo(() => {
    const result = new Map<string, 'applied' | 'pending' | 'processing' | 'conflict'>();
    const pending = new Map<string, Set<number> | 'whole'>();
    for (const id of recentAdoption) result.set(id, 'applied');
    for (const batch of suggestions)
      for (const entry of batch.entries) {
        result.set(entry.id, 'pending');
        const prior = pending.get(entry.id);
        if (entry.field !== 'body' || !entry.paragraphs) pending.set(entry.id, 'whole');
        else if (prior !== 'whole') {
          const ordinals = prior ?? new Set<number>();
          for (const ordinal of entry.paragraphs) ordinals.add(ordinal);
          pending.set(entry.id, ordinals);
        }
      }
    if (locked) for (const id of activeIds) result.set(id, 'processing');
    for (const conflict of conflicts) result.set(conflict.id, 'conflict');
    return { result, pending };
  }, [recentAdoption, suggestions, locked, activeIds, conflicts]);
  const cardSource = useMemo<MapCardSource>(
    () => ({ value, numbers, language, legacy: profile.legacy, statuses: statuses.result }),
    // The editor reads through its mutable draft ref, including IME and retry windows.
    [numbers, language, profile.legacy, statuses, draftVersion],
  );
  const navigation = useNavigation(snapshot, editorElement, cardSource, displayRoot);
  const { visible, layout } = navigation;
  const { setSelection, view, setView, zoom, board, center } = navigation;
  const selection = useMemo(
    () => (newHeading ? [newHeading.node.id] : navigation.selection),
    [newHeading, navigation.selection],
  );
  const lead = navigation.chapterLead
    ? snapshot?.root.children.find((n) => n.id === navigation.chapterLead)
    : undefined;
  const chapterLead = lead && value(lead, 'body').trim() ? lead.id : undefined;
  const fileKey = documentKey(snapshot);
  const onboarding = useOnboarding(fileKey);
  useEffect(() => {
    if (newHeading && newHeading.owner === fileKey && displayRoot === snapshot?.root) {
      adding.current = undefined;
      setNewHeading(undefined);
      setNotice(t('conflictChangedAgain'));
    }
  }, [fileKey, displayRoot, snapshot?.root, newHeading]);
  const targets = useMemo(
    () =>
      aiTargets(
        fileKey,
        rows.map(({ node }) => node.id),
        selection,
        chapterLead,
      ),
    [fileKey, rows, selection, chapterLead],
  );
  const autoTitleIds = useMemo(
    () => (diagnostics === 'import' ? selectedAutoTitles(rows, targets.ids) : []),
    [diagnostics, rows, targets],
  );
  async function generateTitles() {
    await requestAi('title', autoTitleIds, t('autoTitleInstruction'), expansion, (saved) => {
      if (!currentDocument() || latestTargets.current.key !== targets.key) return false;
      const eligible = selectedAutoTitles(flatten(saved.root), targets.ids);
      return (
        eligible.length === autoTitleIds.length && eligible.every((id, i) => id === autoTitleIds[i])
      );
    });
  }
  function nodeTargets(id: string) {
    return aiTargets(fileKey, id !== newHeading?.node.id && numbers.has(id) ? [id] : [], [id]);
  }
  const targetNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const { node } of rows) {
      const heading = numbers.get(node.id)!;
      const title = nodeTitleParts(node, value(node, 'title'), heading, profile.legacy).text;
      let position: string;
      if (!heading.depth) position = t('targetDocument');
      else if (node.kind === 'preamble') position = t('targetPreamble');
      else if (scheme === 'none')
        position = heading.path
          .map((n, i) =>
            t(i === 0 ? 'chapterPosition' : i === 1 ? 'sectionPosition' : 'itemPosition').replace(
              '{n}',
              String(n),
            ),
          )
          .join(language.startsWith('zh') ? '' : ', ');
      else position = heading.path.join('.');
      names.set(node.id, title && title !== position ? position + ' ' + title : position);
    }
    return names;
  }, [rows, numbers, draftVersion, profile.legacy, language, scheme]);
  function targetName(id: string) {
    return targetNames.get(id) ?? t('referenceDeleted');
  }
  function targetLine(label: CopyKey, ids: string[], count = ids.length) {
    return t(label)
      .replace('{n}', String(count))
      .replace('{names}', () => ids.map(targetName).join(' · '));
  }
  useEffect(
    () =>
      setInlineEdit((old) =>
        old?.view === view && old.path === snapshot?.path && old.documentId === snapshot?.id
          ? old
          : undefined,
      ),
    [snapshot?.path, snapshot?.id, view],
  );
  const latestTargets = useRef(targets);
  latestTargets.current = targets;
  function instructionFor(scope: AiTargets) {
    return instructionForSelection(instructionDraft, scope.key);
  }
  const instruction = instructionFor(targets);
  function setInstruction(text: string, scope = targets) {
    setInstructionDraft({ key: scope.key, text });
  }
  useEffect(() => setInstructionDraft({ key: targets.key, text: '' }), [targets.key]);
  const aiReviewCount = suggestions.reduce((count, b) => count + b.entries.length, 0);
  useEffect(() => {
    if (aiReviewCount) onboarding.offer('review');
  }, [fileKey, aiReviewCount, onboarding.offer]);
  const viewRef = useRef(view);
  viewRef.current = view;
  function announceSuggestions() {
    if (viewRef.current !== 'preview') openDrawer('ai-review');
  }
  // One paper activation entry point for pointer, touch and keyboard.
  function activatePaperSuggestion(key: string) {
    const item = review.byKey.get(key);
    if (!item) return;
    review.select(key, false);
    if (item.reason) openDrawer('ai-review');
    else if (!locked && !revising.includes(key))
      setReviewRequest({ key, digest: item.entry.digest });
  }
  const wasLocked = useRef(false);
  const priorBatches = useRef(new Set<string>());
  useEffect(() => {
    if (wasLocked.current && !locked) {
      if (aiReviewCount) announceSuggestions();
    }
    wasLocked.current = locked;
  }, [locked, aiReviewCount]);
  function setDiagnostics(value: 'import' | 'references' | null) {
    if (value) setDrawer(null);
    setDiagnosticsState(value);
    setMenu(false);
  }
  function openDrawer(value: typeof drawer) {
    if (drawer === 'paste' && value !== 'paste') {
      setPasteText('');
      setPastePreview(null);
    }
    if (value) {
      setDiagnosticsState(null);
      setSearchOpen(false);
    }
    setDrawer(value);
    setMenu(false);
  }
  const helpOrigin = useRef<HTMLElement | null>(null);
  function openHelp(origin?: HTMLElement | null) {
    helpOrigin.current = origin ?? (document.activeElement as HTMLElement);
    openDrawer('help');
  }
  function closeHelp() {
    openDrawer(null);
    focusWithoutSelecting(
      helpOrigin.current?.isConnected ? helpOrigin.current : editorElement.current,
    );
  }
  const labels = useMemo(
    () => new Map([...numbers].map(([id, n]) => [id, profile.legacy ? n.label : n.heading])),
    [numbers, profile.legacy],
  );
  const references = useMemo(
    () => (snapshot ? checkReferences(snapshot.root) : []),
    [snapshot?.root],
  );
  const selected = rows.find((r) => r.node.id === selection[selection.length - 1])?.node;
  const call = useCallback(
    <T>(method: string, args: object = {}) =>
      request<T>(method, { sessionId, path: pathRef.current, ...args }),
    [request, sessionId],
  );
  function isCurrentGeneration(generation: number) {
    return mounted.current && generation === documentEpoch.current;
  }
  function currentDocument(token?: string) {
    return (
      !switching.current &&
      isCurrentGeneration(renderEpoch) &&
      documentKey(snapshot) === documentKey(snapRef.current) &&
      (token === undefined || token === snapRef.current?.token)
    );
  }
  function isOpenDocument({ path, documentId }: SidebarTarget) {
    return path === pathRef.current && (!documentId || documentId === snapRef.current?.id);
  }
  async function documentRequest<T>(method: string, args: object = {}, current = currentDocument) {
    if (!current()) return;
    try {
      const result = await call<T>(method, { path: snapshot?.path, ...args });
      if (current()) return result;
    } catch (error) {
      if (current()) throw error;
    }
  }
  useEffect(() => {
    if (drawer !== 'export' || !exportReview) return;
    let alive = true;
    void perform(async () => {
      const check = await call<ExportCheck>('export-check', {
        scheme,
        articleTitle,
      });
      if (alive) setExportReview({ ...check, format: exportReview.format });
    });
    return () => {
      alive = false;
    };
  }, [drawer, scheme, articleTitle, snapshot?.token, suggestions]);
  useEffect(() => {
    if (drawer !== 'revisions' || revisionData?.token === snapshot?.token) return;
    let alive = true;
    void perform(async () => {
      const data = await call<{ rows: RevisionRow[]; token: string; hasSource: boolean }>(
        'revisions',
      );
      if (alive) setRevisionData(data);
    });
    return () => {
      alive = false;
    };
  }, [drawer, snapshot?.token]);
  function accept(s: Snapshot, recovered = false, fromDisk = false) {
    const old = snapRef.current;
    const same = documentKey(old) === documentKey(s);
    if (!fromDisk && old && (!same || old.revision > s.revision)) return;
    if (same && old?.detection && !s.detection)
      s = { ...s, detection: old.detection, importSummary: old.importSummary };
    if (old?.token !== s.token || !same) stateEpoch.current++;
    if (!same || old?.token !== s.token)
      setPasteFeedback((old) => (same && old?.stage === 'section' ? old : undefined));
    if (!same) {
      documentEpoch.current++;
      priorBatches.current = new Set();
      wasLocked.current = false;
      setSelection([]);
      setEditing(undefined);
      adding.current = undefined;
      setNewHeading(undefined);
      setInlineEdit(undefined);
      setPasteText('');
      setPastePreview(null);
      setActiveIds([]);
      setRecentAdoption([]);
      anchor.current = undefined;
      treeFocus.current = undefined;
      if (draft.current) persistDraft();
      draft.current = null;
      setConflicts([]);
      conflictSnapshot.current = undefined;
      try {
        const settings = readPreferences(localStorage, documentKey(s), s.id);
        preferencesRef.current = settings;
        setPreferences(settings);
        setRecovery(repository().load(s.id, s.path));
      } catch {
        setLocalError(t('draftStorageError'));
      }
      knownDrafts.current = undefined;
      setReviewRequest(undefined);
      setReviewDrafts([]);
      setRevising([]);
      knownSuggestions.current = undefined;
      setSuggestions([]);
      setPaperMode('markup');
      setQueueNotice(null);
      setDrawer(null);
      setSearchOpen(false);
      setDiagnostics(null);
      setExpansion(s.expansionDefault ?? 'one');
      setOutlineEditing(undefined);
    }
    if (!same || old?.token !== s.token) {
      // Undo/redo moves the cursor while the last recorded adoption keeps its ID.
      const newlyAdopted =
        same && !recovered && !s.canRedo && s.adoptionId && s.adoptionId !== old?.adoptionId;
      setRecentAdoption(newlyAdopted ? (s.adoptedIds ?? []) : []);
    }
    snapRef.current = s;
    setSnapshot(s);
    pathRef.current = s.path;
  }
  useEffect(() => {
    if (!notice || notice === t('help')) return;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const requestedPath = pathRef.current,
        epoch = stateEpoch.current;
      try {
        const result = await call<State>('state', {
          known: snapRef.current?.token,
          knownSuggestions: knownSuggestions.current,
          knownDrafts: knownDrafts.current,
        });
        if (!alive) return;
        if (
          !switching.current &&
          epoch === stateEpoch.current &&
          requestedPath === pathRef.current
        ) {
          if (
            result.snapshot &&
            documentKey(result.snapshot) === documentKey(snapRef.current) &&
            result.snapshot.revision < snapRef.current!.revision
          )
            setNotice(t('restoredVersion'));
          if (result.snapshot) accept(result.snapshot, result.alert?.kind === 'restored', true);
          setFiles(result.files);
          setLocked(result.locked);
          if (result.reviewDrafts) {
            setReviewDrafts(result.reviewDrafts);
            knownDrafts.current = result.draftToken;
          }
          const revisingKeys = result.revising?.map((r) => reviewKey(r.batchId, r.id)) ?? [];
          setRevising((old) =>
            old.length === revisingKeys.length && old.every((k, i) => k === revisingKeys[i])
              ? old
              : revisingKeys,
          );
          const active = result.scope?.ids ?? [];
          setActiveIds((old) =>
            old.length === active.length && old.every((id, i) => id === active[i]) ? old : active,
          );
          setIntegrityAlert(result.alert ?? null);
          if (result.suggestions) {
            if (
              knownSuggestions.current &&
              result.suggestions.some((b) => !priorBatches.current.has(b.id))
            )
              announceSuggestions();
            priorBatches.current = new Set(result.suggestions.map((b) => b.id));
            setSuggestions(result.suggestions);
            setQueueNotice(result.queueNotice ?? null);
            knownSuggestions.current = result.suggestionToken;
          }
          pollHealthRef.current = healthy;
          setPollHealth(healthy);
          setLoaded(true);
        }
      } catch (e) {
        if (alive && !switching.current && epoch === stateEpoch.current) {
          pollHealthRef.current = pollFailed(
            pollHealthRef.current,
            e instanceof Error ? e.message : String(e),
          );
          setPollHealth(pollHealthRef.current);
        }
      }
      if (alive) timer = setTimeout(poll, retryDelay(pollHealthRef.current));
    }
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [call]);
  const flushOnClose = useRef<() => Promise<void>>();
  flushOnClose.current = flush;
  useEffect(() => {
    const address = tab.navigation.address;
    const match = /^dsh-resource:\/\/file\/session\/[^/]+\/(.+)$/.exec(address.split(/[?#]/)[0]);
    const params = tab.navigation.params;
    const path = match
      ? match[1].split('/').map(decodeURIComponent).join('/')
      : params && 'path' in params
        ? params.path
        : undefined;
    const targetId = params && 'documentId' in params ? params.documentId : undefined;
    if (!path) return;
    if (!switching.current && isOpenDocument({ path, documentId: targetId })) {
      lastSidebarRead.current++;
      return;
    }
    void perform(() => selectDocument(path, !match, targetId));
  }, [tab.navigation.address, tab.navigation.revision]);
  useEffect(() => {
    mounted.current = true;
    const handler = (e: BeforeUnloadEvent) => {
      if (draft.current) {
        void flushOnClose.current?.().catch(() => {});
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => {
      mounted.current = false;
      window.removeEventListener('beforeunload', handler);
      clearTimeout(saveTimer.current);
      void flushOnClose.current?.().catch(() => {});
    };
  }, []);
  async function perform(work: () => Promise<void>) {
    setError('');
    setErrorDetails('');
    setBusy(true);
    busyActions.current++;
    try {
      await work();
    } catch (e) {
      const failure = e as { message?: string; code?: string; details?: object };
      const safe =
        failure.code ||
        (/[\u4e00-\u9fff]/.test(failure.message ?? '') &&
          !/(?:[A-Z]:\\|\/[^\s/]+\/|E[A-Z]{3,}|Error:)/.test(failure.message ?? ''));
      setError(safe ? (failure.message ?? t('retryHint')) : t('retryHint'));
      setErrorDetails(
        failure.details && Object.keys(failure.details).length
          ? JSON.stringify(failure.details, null, 2)
          : safe
            ? ''
            : String(e),
      );
    } finally {
      if (--busyActions.current === 0) setBusy(false);
    }
  }
  function value(n: MindNode, field: 'title' | 'body' | 'note') {
    return draft.current?.changes[n.id]?.[field] ?? n[field] ?? '';
  }
  function edit(n: MindNode, field: 'title' | 'body' | 'note', text: string) {
    if (recoveryRef.current) {
      setError(t('chooseRecovery'));
      return;
    }
    if (!snapRef.current) return;
    setPasteFeedback(undefined);
    draft.current = editDraft(snapRef.current, draft.current, n, field, text);
    persistDraft();
    refreshDraft((x) => x + 1);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (!composingNodes.current.size && !conflictSnapshot.current) void perform(flush);
    }, 550);
  }
  function flush() {
    return operations.current.run(flushNow);
  }
  async function flushNow(): Promise<void> {
    clearTimeout(saveTimer.current);
    if (recoveryRef.current) throw new Error(t('chooseRecovery'));
    if (composingNodes.current.size) throw new Error(t('compositionWait'));
    if (conflictSnapshot.current) throw new Error(t('chooseConflicts'));
    if (saving.current) {
      await saving.current;
      if (draft.current) return flushNow();
      return;
    }
    const pending = draft.current;
    if (!pending) return;
    let sent = structuredClone(pending);
    const task = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        let result: Snapshot;
        try {
          result = await call<Snapshot>('change', {
            path: sent.path,
            revision: sent.revision,
            token: sent.token,
            operations: Object.entries(sent.changes).map(([id, changes]) => ({
              type: 'update',
              id,
              ...changes,
            })),
          });
        } catch (error) {
          if (!mounted.current || (error as { code?: string }).code !== 'CONFLICT' || attempt === 2)
            throw error;
          const latest = (await call<State>('state', { path: sent.path })).snapshot;
          if (!latest) throw error;
          prepareMerge(latest);
          if (conflictSnapshot.current) throw new Error(t('chooseConflicts'));
          if (!draft.current) return;
          sent = structuredClone(draft.current);
          continue;
        }
        draft.current = acknowledgeDraft(draft.current, sent, result);
        try {
          repository().acknowledge(sent, result);
        } catch {
          setLocalError(t('draftStorageError'));
        }
        if (documentKey(snapRef.current) === documentKey(result)) accept(result);
        refreshDraft((x) => x + 1);
        return;
      }
    })();
    saving.current = task;
    try {
      await task;
    } finally {
      saving.current = undefined;
    }
  }
  async function change(operations: Operation[]) {
    return enqueueChange(operations);
  }
  function enqueueChange(batch: Operation[]) {
    const owner = documentKey(snapshot);
    return operations.current.run(async () => {
      if (owner !== documentKey(snapRef.current) || switching.current) return;
      await flushNow();
      const s = snapRef.current!;
      accept(
        await call<Snapshot>('change', { revision: s.revision, token: s.token, operations: batch }),
      );
    });
  }
  function select(
    id: string,
    e: Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'> & { nativeEvent?: MouseEvent },
  ) {
    if (id === adding.current?.node.id) return;
    focusRequest.current++;
    if (snapRef.current) treeFocus.current = { documentId: documentKey(snapRef.current), id };
    navigation.markReading(id);
    if (outlineEditing !== id || e.ctrlKey || e.metaKey || e.shiftKey) setOutlineEditing(undefined);
    const chapter = snapshot && ancestors(snapshot.root, id)[1];
    if (chapter) navigation.setChapter(chapter.id);
    let next = [id];
    if (e.shiftKey && anchor.current) {
      const ids = visible.map((r) => r.node.id);
      const a = ids.indexOf(anchor.current);
      const b = ids.indexOf(id);
      if (a >= 0 && b >= 0) next = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
    } else if (e.ctrlKey || e.metaKey) {
      const previous = navigation.selection;
      next = previous.includes(id) ? previous.filter((entry) => entry !== id) : [...previous, id];
    }
    setSelection(next);
    if (view !== 'preview' && navigation.hasContent && next.length) {
      const device = (e.nativeEvent as PointerEvent | undefined)?.pointerType;
      onboarding.offer(
        'selection',
        device ? navigation.editorWidth < breakpoints.narrow || device !== 'mouse' : undefined,
      );
    }
    if (!e.shiftKey) anchor.current = id;
    if (view === 'map' && next.length === 1)
      requestAnimationFrame(() => navigation.ensure(next[0], true));
  }
  const preserveFocusSelection = useRef(false);
  function focusWithoutSelecting(element?: HTMLElement | null) {
    preserveFocusSelection.current = true;
    try {
      element?.focus({ preventScroll: true });
    } finally {
      preserveFocusSelection.current = false;
    }
  }
  function focusProps(id: string, selectOnFocus = true) {
    return {
      onPointerDown: (event: React.PointerEvent) => {
        if (event.button === 1) {
          // Let the browser/host handle the auxiliary button. Its native focus must not select a new AI target.
          preserveFocusSelection.current = true;
          setTimeout(() => {
            preserveFocusSelection.current = false;
          }, 0);
          return;
        }
        if (event.button !== 0) return;
        preserveFocusSelection.current = event.ctrlKey || event.metaKey || event.shiftKey;
        if (!preserveFocusSelection.current) setSelection([id]);
      },
      onPointerUp: () => {
        preserveFocusSelection.current = false;
      },
      onFocus: () => {
        if (selectOnFocus && !preserveFocusSelection.current) setSelection([id]);
        preserveFocusSelection.current = false;
      },
      onClick: (event: React.MouseEvent) => event.stopPropagation(),
    };
  }
  function clearSelection() {
    anchor.current = undefined;
    setSelection([]);
  }
  function replaceSelection(ids: string[], preferChapter = false) {
    anchor.current = ids.at(-1);
    setSelection(ids);
    if (ids.length && navigation.hasContent) onboarding.offer('selection', preferChapter);
  }
  function rememberSelection() {
    const previousAnchor = anchor.current;
    return () => {
      const current = snapRef.current;
      if (!current || documentKey(current) !== fileKey) return;
      const valid = new Set(flatten(current.root).map(({ node }) => node.id));
      anchor.current = previousAnchor && valid.has(previousAnchor) ? previousAnchor : undefined;
      setSelection(
        selection.filter((id) => valid.has(id)),
        chapterLead && valid.has(chapterLead) ? chapterLead : undefined,
      );
    };
  }
  function selectLevel() {
    const depth = rows.find((row) => row.node.id === selection.at(-1))?.depth ?? 1;
    const ids = rows.filter((row) => row.depth === depth).map((row) => row.node.id);
    if (ids.length && navigation.hasContent) onboarding.offer('selection');
    setSelection(ids);
  }
  function selectChapter() {
    let row = rows.find((row) => row.node.id === selection.at(-1));
    while (row && row.depth > 1) row = rows.find((parent) => parent.node.id === row!.parent?.id);
    if (!row) return;
    const { node, depth } = row;
    if (navigation.hasContent) onboarding.offer('selection');
    if (!node.children.length) return setSelection([node.id]);
    const descendants = flatten(node)
      .slice(1)
      .map((child) => child.node.id);
    setSelection(descendants, depth === 1 && value(node, 'body').trim() ? node.id : undefined);
  }
  async function add(child: boolean, target = selected, fromPlus = false) {
    const s = snapRef.current;
    if (!s || !target || locked || recoveryRef.current || adding.current || switching.current)
      return;
    const row = flatten(s.root).find((r) => r.node.id === target.id);
    const parent = child ? row?.node : row?.parent;
    if (!parent || parent.kind === 'preamble') return;
    const next: NewHeading = {
      owner: documentKey(s),
      parentId: parent.id,
      afterId: child ? undefined : target.id,
      node: { id: crypto.randomUUID(), title: '', body: '', children: [], collapsed: false },
    };
    adding.current = next;
    headingText.current = '';
    setNewHeading(next);
    setEditing(undefined);
    setInlineEdit(undefined);
    openDrawer(null);
    if (view === 'map' && navigation.hideLabels) navigation.readable(target.id);
    navigation.unfold(next.node.id, projectHeading(s.root, next));
    if (fromPlus) onboarding.offer('plus');
  }
  async function finishHeading(text: string, reason: 'enter' | 'blur' | 'escape') {
    const item = newHeading;
    if (!item || adding.current !== item || submittingHeading.current === item) return;
    const title = text.trim();
    if (!title || reason === 'escape') {
      if (reason === 'enter') return;
      adding.current = undefined;
      setNewHeading(undefined);
      if (reason === 'escape') locateSelection(item.afterId ?? item.parentId);
      return;
    }
    if (locked || recoveryRef.current) return;
    submittingHeading.current = item;
    const focus = focusRequest.current;
    try {
      await operations.current.run(async () => {
        await flushNow();
        const s = snapRef.current;
        if (!s || documentKey(s) !== item.owner || adding.current !== item) return;
        const parent = flatten(s.root).find((r) => r.node.id === item.parentId)?.node;
        const index = parent ? headingIndex(parent, item.afterId) : -1;
        if (index < 0) throw new Error(t('conflictChangedAgain'));
        const result = await call<Snapshot>('change', {
          path: s.path,
          revision: s.revision,
          token: s.token,
          operations: [{ type: 'add', parentId: item.parentId, index, nodes: [{ title }] }],
        });
        if (adding.current !== item || documentKey(snapRef.current) !== item.owner) return;
        const id = ancestors(result.root, item.parentId).at(-1)!.children[index].id;
        adding.current = undefined;
        setNewHeading(undefined);
        accept(result);
        if (reason === 'enter' && focus === focusRequest.current && !switching.current) {
          setSelection([id]);
          navigation.reveal(id, result.root);
          locateSelection(id);
        }
      });
    } finally {
      submittingHeading.current = undefined;
    }
  }
  async function remove(targets = selection, preserveSelection = false) {
    const ids = new Set(targets);
    const top = rows.filter(
      (r) =>
        ids.has(r.node.id) &&
        r.parent &&
        !rows.some(
          (p) =>
            ids.has(p.node.id) &&
            p.node.id !== r.node.id &&
            flatten(p.node).some((x) => x.node.id === r.node.id),
        ),
    );
    if (top.length && window.confirm(t('confirmDelete'))) {
      const removed = top.reduce((sum, row) => sum + flatten(row.node).length, 0);
      await change(top.map((r) => ({ type: 'delete', id: r.node.id })));
      if (preserveSelection) locateSelection(top[0].parent!.id);
      else focusNode(top[0].parent!.id);
      setNotice(t('deletedCount').replace('{n}', String(removed)));
    }
  }
  async function history(redo = false, aiOnly = false, expectedToken?: string) {
    return operations.current.run(async () => {
      if (!currentDocument()) return;
      await flushNow();
      if (!currentDocument(expectedToken)) return;
      const s = snapRef.current;
      if (!s || !(redo ? s.canRedo : s.canUndo)) return;
      const result = await documentRequest<Snapshot>('undo', {
        revision: s.revision,
        token: s.token,
        redo,
        aiOnly,
      });
      if (result && currentDocument()) accept(result);
    });
  }
  async function ai(
    mode: string,
    {
      nodeScope,
      action,
      task,
      depth,
    }: {
      nodeScope?: AiTargets;
      action?: WritingAction;
      task?: string;
      depth?: Expansion;
    } = {},
  ) {
    if (!currentDocument()) return;
    const scope = nodeScope ?? targets;
    const ids = actionTargetIds(scope, mode, action);
    const author = instructionFor(scope);
    const usesDraft = task === undefined && !(nodeScope && action);
    const text = task ?? (action ? writingInstruction(action, usesDraft ? author : '') : author);
    const sent = await requestAi(
      mode,
      ids,
      text,
      depth,
      () => currentDocument() && latestTargets.current.key === targets.key,
    );
    if (sent && usesDraft && author)
      setInstructionDraft((old) =>
        old.key === scope.key && old.text === author ? { key: old.key, text: '' } : old,
      );
  }
  async function requestAi(
    mode: string,
    ids: string[],
    task: string,
    depth = expansion,
    valid: (saved: Snapshot) => boolean = () => true,
  ) {
    const generation = documentEpoch.current;
    await flush();
    const s = snapRef.current;
    if (!s || switching.current || !isCurrentGeneration(generation)) return;
    const liveIds = new Set(flatten(s.root).map(({ node }) => node.id));
    if (!valid(s) || !ids.length || ids.some((id) => !liveIds.has(id))) {
      setNotice(t('scopeChanged'));
      return;
    }
    stateEpoch.current++;
    await call('ai', {
      path: s.path,
      revision: s.revision,
      token: s.token,
      ids,
      mode,
      instruction: task,
      expansion: depth,
    });
    stateEpoch.current++;
    if (switching.current || !isCurrentGeneration(generation)) return;
    setLocked(true);
    setActiveIds(ids);
    openDrawer('ai-review');
    return true;
  }
  function locateSelection(id = selection.at(-1)) {
    if (!id) return;
    const request = ++focusRequest.current;
    navigation.locate(id, () => {
      if (focusRequest.current !== request) return;
      const node = [
        ...(editorElement.current?.querySelectorAll<HTMLElement>('[data-node-id]') ?? []),
      ].find((element) => element.dataset.nodeId === id);
      focusWithoutSelecting(node?.querySelector<HTMLElement>('.mw-node-title'));
    });
  }
  function focusNode(id: string) {
    setSelection([id]);
    locateSelection(id);
  }
  function structureChange(build: (root: MindNode) => Operation[]) {
    const documentId = documentKey(snapRef.current);
    return operations.current.run(async () => {
      await flushNow();
      const s = snapRef.current!;
      if (documentKey(s) !== documentId || switching.current) return;
      const batch = build(s.root);
      if (batch.length)
        accept(
          await call<Snapshot>('change', {
            path: s.path,
            revision: s.revision,
            token: s.token,
            operations: batch,
          }),
        );
    });
  }
  function moveSelected(offset: number, id = selected?.id) {
    return structureChange((root) => {
      const row = flatten(root).find((row) => row.node.id === id);
      if (!row?.parent) return [];
      const index = row.parent.children.indexOf(row.node) + offset;
      if (index < 0 || index >= row.parent.children.length) return [];
      return [{ type: 'move', id: row.node.id, parentId: row.parent.id, index }];
    });
  }
  const sortKey = useRef<(event: KeyboardEvent) => void>();
  sortKey.current = (event) => {
    if (
      event.defaultPrevented ||
      composing(event) ||
      composingNodes.current.size ||
      locked ||
      drawer ||
      creating ||
      diagnostics ||
      searchOpen ||
      view === 'preview'
    )
      return;
    const command = nodeCommand(event, true, false);
    if (command !== 'move-down' && command !== 'move-up') return;
    const target = event.target;
    const editor = editorElement.current;
    if (!(target instanceof HTMLElement) || !editor || !editor.getClientRects().length) return;
    const node =
      editor.contains(target) &&
      !target.closest('input,textarea,select,button,a,[contenteditable=true]')
        ? target.closest<HTMLElement>('[data-node-id]')
        : null;
    // Chromium can leave focus on body when moving the focused DOM subtree.
    // Continue only the last explicit tree interaction in this editor/document.
    const owned = treeFocus.current;
    const id =
      node?.dataset.nodeId ??
      ((target === document.body || target === editor) &&
      owned?.documentId === documentKey(snapRef.current)
        ? owned?.id
        : undefined);
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    if (selection.includes(id))
      void perform(() => moveSelected(command === 'move-down' ? 1 : -1, id));
  };
  useEffect(() => {
    const track = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      ++focusRequest.current;
      const node =
        editorElement.current?.contains(target) &&
        !target.closest('input,textarea,select,button,a,[contenteditable=true]')
          ? target.closest<HTMLElement>('[data-node-id]')
          : null;
      treeFocus.current =
        node?.dataset.nodeId && snapRef.current
          ? { documentId: documentKey(snapRef.current), id: node.dataset.nodeId }
          : undefined;
    };
    const reset = () => {
      treeFocus.current = undefined;
    };
    const onKey = (event: KeyboardEvent) => sortKey.current?.(event);
    document.addEventListener('pointerdown', track, true);
    document.addEventListener('focusin', track, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', reset);
    return () => {
      document.removeEventListener('pointerdown', track, true);
      document.removeEventListener('focusin', track, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', reset);
    };
  }, []);
  function moveDestinations(targets: string[]) {
    const ids = new Set(targets);
    const selectedRows = rows.filter((r) => ids.has(r.node.id));
    if (selectedRows.some((r) => r.node.kind === 'preamble'))
      return rows.filter((r) => !r.parent && !ids.has(r.node.id));
    const excluded = new Set(
      selectedRows.flatMap((r) => flatten(r.node).map((child) => child.node.id)),
    );
    return rows.filter((r) => r.node.kind !== 'preamble' && !excluded.has(r.node.id));
  }
  function moveTo(parentId: string, targets = selection) {
    const ids = new Set(targets);
    return structureChange((root) => {
      if (ids.has(root.id) || ancestors(root, parentId).some((n) => ids.has(n.id))) return [];
      return flatten(root)
        .filter(
          (row) =>
            ids.has(row.node.id) &&
            row.parent &&
            !ancestors(root, row.parent.id).some((n) => ids.has(n.id)),
        )
        .map(({ node }) => ({ type: 'move', id: node.id, parentId }));
    });
  }
  function keydown(e: React.KeyboardEvent) {
    if (composing(e.nativeEvent) || composingNodes.current.size) return;
    const target = e.target as HTMLElement;
    if (target.closest('.mw-writing-actions,.mw-node-menu')) return;
    // The map owns unmodified Space from keydown through keyup, including on a blank surface.
    if (e.key === ' ' && board.current?.contains(target)) return;
    if (e.key === '?' && !target.closest('input,textarea,select,[contenteditable=true]')) {
      e.preventDefault();
      e.stopPropagation();
      if (drawer === 'help') closeHelp();
      else openHelp(target);
      return;
    }
    const interactive = !!target.closest('input,textarea,select,button,a,[contenteditable=true]');
    const focused =
      view !== 'preview' && !interactive && !!target.closest('[data-node-id],[data-tree-surface]');
    if (
      view === 'map' &&
      (e.ctrlKey || e.metaKey) &&
      e.key === '0' &&
      !target.closest('input,textarea,select,[contenteditable=true]')
    ) {
      e.preventDefault();
      e.stopPropagation();
      navigation.center();
      return;
    }
    const paperHistory =
      view === 'preview' &&
      (e.ctrlKey || e.metaKey) &&
      /^[zy]$/i.test(e.key) &&
      !!target.closest('.mw-preview article p[data-paste-after]');
    const command = nodeCommand(e.nativeEvent, focused || paperHistory, interactive);
    if (!command) return;
    e.preventDefault();
    e.stopPropagation();
    if (command === 'search') {
      setSearchOpen(true);
      setMenu(false);
      return;
    }
    if (command === 'escape') {
      setMenu(false);
      openDrawer(null);
      setDiagnostics(null);
      setSearchOpen(false);
      setEditing(undefined);
      if (selected) focusNode(selected.id);
      return;
    }
    if (command === 'select-level') {
      selectLevel();
      return;
    }
    if (command === 'undo' || command === 'redo') {
      if (!locked) void perform(() => history(command === 'redo'));
      return;
    }
    if (command === 'child' && !locked && snapshot && target.closest('.mw-empty h2')) {
      void perform(() => add(true, snapshot.root));
      return;
    }
    if (!selected) return;
    if (view === 'map' && navigation.hideLabels) {
      navigation.readable(selected.id);
      return;
    }
    const index = visible.findIndex((row) => row.node.id === selected.id);
    const row = rows.find((row) => row.node.id === selected.id);
    if (command === 'previous' || command === 'next') {
      const next = visible[index + (command === 'next' ? 1 : -1)];
      if (next) {
        onboarding.offer('selection');
        focusNode(next.node.id);
      }
      return;
    }
    if (command === 'parent') {
      if (row?.parent) {
        onboarding.offer('selection');
        focusNode(row.parent.id);
      }
      return;
    }
    if (command === 'first-child') {
      if (selected.children[0]) {
        onboarding.offer('selection');
        focusNode(selected.children[0].id);
      }
      return;
    }
    if (locked) return;
    if ((command === 'child' || command === 'sibling') && !e.repeat)
      void perform(() => add(command === 'child'));
    if (command === 'edit') setEditing(selected.id);
    if (command === 'delete') void perform(remove);
    if (command === 'move-up' || command === 'move-down')
      void perform(() => moveSelected(command === 'move-up' ? -1 : 1));
  }
  function dropZone(e: React.DragEvent) {
    const rect = e.currentTarget.getBoundingClientRect();
    const across = (e.currentTarget as HTMLElement).dataset.dropAxis === 'x';
    const fraction = across
      ? (e.clientX - rect.left) / rect.width
      : (e.clientY - rect.top) / rect.height;
    return fraction < 0.25 ? 'before' : fraction > 0.75 ? 'after' : 'inside';
  }
  function dragOver(e: React.DragEvent, id: string) {
    if (!dragId.current || locked) return;
    e.preventDefault();
    e.stopPropagation();
    const zone = dropZone(e);
    if (drop?.id !== id || drop.zone !== zone) setDrop({ id, zone });
  }
  function onDrop(e: React.DragEvent, targetId: string) {
    e.preventDefault();
    e.stopPropagation();
    const source = dragId.current;
    dragId.current = undefined;
    const zone = dropZone(e);
    setDrop(undefined);
    if (!source || source === targetId || locked) return;
    const target = rows.find((r) => r.node.id === targetId);
    if (!target) return;
    const parent = zone === 'inside' ? target.node : target.parent;
    if (!parent || parent.kind === 'preamble') return;
    const siblings = parent.children.filter((n) => n.id !== source);
    const idx = siblings.findIndex((n) => n.id === targetId);
    void perform(() =>
      change([
        {
          type: 'move',
          id: source,
          parentId: parent.id,
          index: zone === 'inside' ? siblings.length : idx + (zone === 'after' ? 1 : 0),
        },
      ]),
    );
  }
  useEffect(() => {
    if (!recentAdoption.length) return;
    const timer = setTimeout(() => setRecentAdoption([]), 3000);
    return () => clearTimeout(timer);
  }, [recentAdoption]);
  function nodeStatus(id: string, part?: number | 'heading') {
    const state = statuses.result.get(id),
      pending = statuses.pending.get(id);
    if (
      state === 'pending' &&
      part !== undefined &&
      pending instanceof Set &&
      (part === 'heading' || !pending.has(part))
    )
      return undefined;
    return state;
  }
  function stateProps(id: string, part?: 'heading') {
    const state = nodeStatus(id, part);
    return {
      'data-selected': selection.includes(id),
      'data-state': state,
      'data-highlight': state === 'applied',
      'data-processing': state === 'processing',
      'data-conflict': state === 'conflict',
    };
  }
  const nodeInteraction = (n: MindNode) => ({
    'data-node-id': n.id,
    draggable:
      !locked && n.id !== snapshot?.root.id && editing !== n.id && n.id !== newHeading?.node.id,
    onClick: (e: React.MouseEvent<HTMLElement>) => {
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey)
        e.currentTarget
          ?.querySelector<HTMLElement>('.mw-node-title')
          ?.focus({ preventScroll: true });
      select(n.id, e);
    },
    onDragStart: (e: React.DragEvent) => {
      dragId.current = n.id;
      e.dataTransfer.setData('text/plain', n.id);
      e.dataTransfer.effectAllowed = 'move';
    },
    onDragEnd: () => {
      dragId.current = undefined;
      setDrop(undefined);
    },
    onDragOver: (e: React.DragEvent) => dragOver(e, n.id),
    onDrop: (e: React.DragEvent) => onDrop(e, n.id),
  });
  const nodeProps = (n: MindNode) => ({
    ...nodeInteraction(n),
    'data-collapsed': n.collapsed,
    ...stateProps(n.id, view === 'outline' ? 'heading' : undefined),
    'data-drop': drop?.id === n.id ? drop.zone : undefined,
  });
  async function reviewExport(format: ExportFormat) {
    setMenu(false);
    await flush();
    if (!currentDocument()) return;
    const check = await documentRequest<ExportCheck>('export-check', { scheme, articleTitle });
    if (!check) return;
    const filename = cleanFilename(exportFilename || snapRef.current!.root.title);
    setExportFilename(filename);
    if (!check.pendingCount && !check.health.length && !check.unresolved.length) {
      await completeExport(format, check, filename);
      return;
    }
    setExportReview({ ...check, format });
    openDrawer('export');
  }
  async function completeExport(
    format: ExportFormat,
    check: ExportCheck,
    filename = exportFilename,
  ) {
    type Result = { text: string; filename: string; base64: string; mime: string };
    let r: Result | undefined;
    try {
      r = await documentRequest<Result>('export', {
        scheme,
        format,
        fontSize,
        layout: pageStyle,
        articleTitle,
        acknowledged: check.token,
        suggestionToken: check.suggestionToken,
        filename,
      });
    } catch (e) {
      if ((e as { code?: string }).code !== 'EXPORT_RECHECK') throw e;
      return reviewExport(format);
    }
    if (!r) return;
    if (format === 'text') {
      await navigator.clipboard.writeText(r.text);
      setNotice(t('copied'));
      setExportReview(null);
      openDrawer(null);
      return;
    }
    const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: r.mime }));
    const link = document.createElement('a');
    link.href = url;
    link.download = r.filename.split(/[/\\]/).pop()!;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    setNotice(`${t('exportHint')}：${r.filename}`);
    setExportReview(null);
    openDrawer(null);
  }
  const download = (format: 'docx' | 'md') => reviewExport(format);
  async function decideAi(
    batchId: string,
    entries: ReviewReceipt[],
    adopt: boolean,
    edit?: SuggestionEdit,
    entireBatch = false,
  ) {
    await operations.current.run(async () => {
      if (!currentDocument()) return;
      await flushNow();
      if (!currentDocument()) return;
      const s = snapRef.current!;
      const result = await call<{
        snapshot: Snapshot;
        suggestions: ReviewedBatch[];
        suggestionToken?: string;
        queueNotice?: string | null;
      }>('suggestion', {
        path: s.path,
        revision: s.revision,
        token: s.token,
        batchId,
        reviewed: entries.map(({ id, digest }) => ({ id, digest })),
        adopt,
        edit,
        entireBatch,
      });
      if (!currentDocument()) return;
      stateEpoch.current++;
      accept(result.snapshot);
      knownSuggestions.current = result.suggestionToken;
      priorBatches.current = new Set(result.suggestions.map((b) => b.id));
      setQueueNotice(result.queueNotice ?? null);
      setSuggestions(result.suggestions);
      if (!result.suggestions.length) {
        openDrawer(null);
        setNotice(t(adopt && result.snapshot.token !== s.token ? 'adopted' : 'discarded'));
      }
    });
  }
  async function setDocumentProfile(
    documentType: DocumentType,
    numberingScheme: Numbering,
    layout: PageStyle,
  ) {
    return operations.current.run(async () => {
      if (!currentDocument()) return;
      await flushNow();
      const s = snapRef.current;
      if (!s || !currentDocument()) return;
      if (s.documentType !== documentType || s.numberingScheme !== numberingScheme) {
        const result = await documentRequest<Snapshot>('profile', {
          revision: s.revision,
          token: s.token,
          documentType,
          numberingScheme,
        });
        if (!result || !currentDocument() || documentKey(result) !== documentKey(s)) return;
        accept(result);
      }
      if (layout !== (preferencesRef.current.layout ?? profileFor(snapRef.current!).layout))
        updatePreferences({ layout });
      openDrawer(null);
    });
  }
  async function setExpansionDefault(value: Expansion) {
    if (!currentDocument()) return;
    await flush();
    const s = snapRef.current;
    if (!s) return;
    const result = await documentRequest<Snapshot>('expansion-default', {
      revision: s.revision,
      token: s.token,
      expansion: value,
    });
    if (!result || !currentDocument() || documentKey(result) !== documentKey(s)) return;
    accept(result);
    if (snapRef.current?.token === result.token) setExpansion(result.expansionDefault ?? value);
  }
  function previewPaste() {
    setPastePreview(parsePaste(pasteText));
  }
  async function insertPaste() {
    if (!pastePreview || !snapshot || locked || starting.current) return;
    starting.current = true;
    try {
      await change([
        { type: 'add', parentId: selected?.id ?? snapshot.root.id, nodes: pastePreview.nodes },
      ]);
      if (currentDocument()) openDrawer(null);
    } finally {
      starting.current = false;
    }
  }
  function pastePlace(id: string, after?: number, reading?: ReadingAnchor): PastePlace | undefined {
    const node = rows.find((r) => r.node.id === id)?.node;
    if (node)
      return {
        id,
        after,
        reading,
        name: numbers.get(id)?.title || node.title,
        preamble: node.kind === 'preamble',
      };
  }
  function writePaste(
    at: PastePlace,
    command: PasteCommand,
    options: {
      token?: string;
      replace?: string;
      consent?: string;
      draftText?: string;
    } = {},
  ) {
    return operations.current.run(async () => {
      if (!currentDocument()) return;
      if (locked) {
        setNotice(t('pasteLocked'));
        return;
      }
      await flushNow();
      const s = snapRef.current;
      if (!s || !currentDocument()) return;
      if (options.token && options.token !== s.token) {
        setNotice(t('pasteChanged'));
        return;
      }
      const result = await documentRequest<PasteResult>('paste', {
        revision: s.revision,
        token: s.token,
        id: at.id,
        after: at.after,
        command,
        replace: options.replace,
        consent: options.consent,
      });
      if (!result) return;
      setNotice('');
      if ('pending' in result) {
        if (!currentDocument(s.token)) return;
        const { suggestions, key, consent, count } = result.pending;
        stateEpoch.current++;
        setSuggestions(suggestions);
        knownSuggestions.current = undefined;
        setPasteFeedback({
          stage: 'review',
          at,
          token: s.token,
          key,
          consent,
          count,
          command,
          replace: options.replace,
        });
        return;
      }
      accept(result.snapshot);
      if (!currentDocument(result.snapshot.token) || draft.current) return;
      const token = result.snapshot.token;
      if (command.mode === 'retract' && options.draftText !== undefined) {
        setPasteFeedback({ stage: 'section', at, token, text: options.draftText });
      } else if (result.receipt) {
        setPasteFeedback({ stage: 'done', at, token, receipt: result.receipt });
        navigation.markReading(at.id, at.reading);
        if (result.receipt.kind === 'sections') {
          const parent = flatten(result.snapshot.root).find((r) => r.node.id === at.id)?.node;
          const child = parent?.children.at(-1);
          if (child) navigation.unfold(child.id, result.snapshot.root);
        }
      }
    });
  }
  function switchPaste() {
    if (pasteFeedback?.stage !== 'done') return;
    const { at, token, receipt } = pasteFeedback;
    const options = { token, replace: receipt.group };
    return receipt.kind === 'body'
      ? writePaste(at, { mode: 'retract' }, { ...options, draftText: receipt.text })
      : writePaste(at, { mode: 'body', text: receipt.text }, options);
  }
  function reviewPaste(proceed: boolean) {
    if (pasteFeedback?.stage !== 'review') return;
    const { key, at, command, replace, token, consent } = pasteFeedback;
    if (proceed) return writePaste(at, command, { replace, token, consent });
    setPasteFeedback(undefined);
    navigation.reveal(at.id);
    review.select(key);
    openDrawer('ai-review');
  }
  function savePasteSection(title: string, text: string) {
    if (pasteFeedback?.stage === 'section')
      return writePaste(pasteFeedback.at, { mode: 'section', title, text });
  }
  function dismissPaste() {
    if (pasteFeedback?.stage === 'section') setNotice(t('pasteAgain'));
    setPasteFeedback(undefined);
  }
  async function menuPaste(id: string, element: HTMLElement, readable: boolean) {
    const at = pastePlace(id);
    if (!at || !snapshot || !currentDocument()) return;
    if (locked) {
      setNotice(t('pasteLocked'));
      return;
    }
    if (readable) {
      let text: string | undefined;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        setClipboardBlocked(true);
      }
      if (!currentDocument(snapshot.token)) return;
      if (text !== undefined) {
        await writePaste(
          at,
          { mode: 'body', text: cleanPasteText(text) },
          { token: snapshot.token },
        );
        return;
      }
    }
    focusWithoutSelecting(element.querySelector<HTMLElement>('.mw-node-title') ?? element);
    setNotice('');
    setPasteFeedback({ stage: 'keyboard', at, token: snapshot.token, view });
  }
  function paste(event: React.ClipboardEvent) {
    const target = event.target as HTMLElement;
    if (
      target.closest(
        'input,textarea,select,.mw-inline-editor,[role="textbox"],[contenteditable]:not([contenteditable="false"]),[data-review-key]',
      )
    )
      return;
    const text = event.clipboardData.getData('text/plain');
    if (!text.trim()) return;
    let at: PastePlace | undefined;
    const keyboard =
      pasteFeedback?.stage === 'keyboard' &&
      pasteFeedback.view === view &&
      target.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId === pasteFeedback.at.id;
    if (keyboard) at = pasteFeedback.at;
    else if (view === 'preview') {
      const paragraph = target.closest<HTMLElement>('.mw-preview article p[data-paste-after]');
      if (!paragraph?.dataset.nodeId || paragraph !== document.activeElement) return;
      at = pastePlace(
        paragraph.dataset.nodeId,
        Number(paragraph.dataset.pasteAfter),
        paragraphAnchor(navigation.preview.current!, paragraph),
      );
    } else if (selected) at = pastePlace(selected.id);
    event.preventDefault();
    event.stopPropagation();
    if (!at) {
      setNotice(t('pasteSelect'));
      return;
    }
    if (locked) {
      setNotice(t('pasteLocked'));
      return;
    }
    const destination = at;
    if (text.length > pasteTextLimit) {
      setNotice(t('pasteTooLong'));
      return;
    }
    const copiedTitle = keyboard ? undefined : copiedNodeTitle(event.clipboardData, text);
    void perform(() =>
      keyboard
        ? writePaste(
            pasteFeedback.at,
            { mode: 'body', text: cleanPasteText(text) },
            { token: pasteFeedback.token },
          )
        : writePaste(
            destination,
            { mode: 'auto', text, copiedTitle },
            { token: view === 'preview' ? snapshot?.token : undefined },
          ),
    );
  }
  async function fixHealth() {
    await flush();
    const s = snapRef.current!;
    accept(await call<Snapshot>('health-fix', { revision: s.revision, token: s.token, scheme }));
  }
  async function reviewRevisions() {
    await flush();
    setRevisionData(await call('revisions'));
    openDrawer('revisions');
  }
  async function exportRevisions() {
    await flush();
    const s = snapRef.current!;
    const result = await call<{ filename: string; base64: string; mime: string }>(
      'export-revisions',
      { revision: s.revision, token: s.token, onlyChanges },
    );
    const url = URL.createObjectURL(
      new Blob([Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0))], {
        type: result.mime,
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = result.filename.split(/[/\\]/).pop()!;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    setNotice(`${t('exportHint')}：${result.filename}`);
  }
  async function importFile(file: File) {
    if (starting.current || locked) return;
    starting.current = true;
    try {
      await flush();
      const content = /\.docx$/i.test(file.name)
        ? btoa(
            Array.from(new Uint8Array(await file.arrayBuffer()), (b) =>
              String.fromCharCode(b),
            ).join(''),
          )
        : await file.text();
      if (!(await switchDocument(() => call<Snapshot>('import', { filename: file.name, content }))))
        return;
      setDiagnostics('import');
      setNotice('');
    } finally {
      starting.current = false;
    }
  }

  async function switchDocument(read: () => Promise<Snapshot | null | undefined>) {
    navigation.savePosition();
    const generation = ++documentEpoch.current;
    const transition: DocumentSwitch = {};
    switching.current = transition;
    stateEpoch.current++;
    knownSuggestions.current = undefined;
    setSuggestions([]);
    setDrawer(null);
    let next: Snapshot | null | undefined;
    try {
      next = await operations.current.run(async () => {
        if (!isCurrentGeneration(generation)) return;
        await flushNow();
        if (isCurrentGeneration(generation)) return read();
      });
    } catch (error) {
      if (isCurrentGeneration(generation) && !transition.pendingSidebar) throw error;
    } finally {
      if (switching.current === transition) switching.current = undefined;
    }
    if (!isCurrentGeneration(generation)) return;
    if (next) accept(next, false, true);
    // The follow-up switch needs the same operation queue to flush the newly opened file.
    if (transition.pendingSidebar && !isOpenDocument(transition.pendingSidebar)) {
      const acceptedGeneration = documentEpoch.current;
      await readSidebarDocument();
      if (!isCurrentGeneration(acceptedGeneration)) return;
    }
    return next;
  }
  async function readSidebarDocument() {
    // A notification can be an echo of an earlier selection. Read the host's current file.
    const sequence = ++lastSidebarRead.current;
    const generation = documentEpoch.current;
    const current = () => isCurrentGeneration(generation) && sequence === lastSidebarRead.current;
    const state = await documentRequest<State>('state', { path: undefined }, current);
    const next = state?.snapshot;
    if (next && current() && documentKey(next) !== documentKey(snapRef.current))
      await switchDocument(async () => next);
  }
  async function selectDocument(path: string, watch = false, documentId?: string) {
    if (!watch) {
      await switchDocument(() => call<Snapshot>('select', { path }));
      return;
    }
    if (!isCurrentGeneration(renderEpoch)) return;
    if (switching.current) switching.current.pendingSidebar = { path, documentId };
    else await readSidebarDocument();
  }
  async function retryDraft() {
    const result = await call<State>('state');
    if (result.snapshot && draft.current) {
      prepareMerge(result.snapshot);
      if (!conflictSnapshot.current) await flush();
    }
  }
  function prepareMerge(latest: Snapshot) {
    if (!draft.current) return;
    const merged = mergeDraft(draft.current, latest);
    draft.current = merged.draft;
    setConflicts(merged.conflicts);
    conflictSnapshot.current = merged.conflicts.length ? latest : undefined;
    accept(latest);
    persistDraft();
    refreshDraft((x) => x + 1);
    if (merged.conflicts.length) openDrawer('conflicts');
  }
  async function resolveConflicts(choices: Record<string, 'mine' | 'latest'>) {
    const previous = conflictSnapshot.current;
    if (!previous || !draft.current) return;
    const latest = (await call<State>('state')).snapshot;
    if (!latest) return;
    if (latest.token !== previous.token) {
      prepareMerge(latest);
      if (conflictSnapshot.current) setError(t('conflictChangedAgain'));
      else {
        await flush();
        openDrawer(null);
      }
      return;
    }
    for (const conflict of conflicts) {
      const choice = choices[`${conflict.id}:${conflict.field}`];
      if (!choice || (choice === 'mine' && conflict.latest === undefined))
        throw new Error(t('chooseConflicts'));
      if (choice === 'latest') delete draft.current.changes[conflict.id][conflict.field];
      else draft.current.base[conflict.id][conflict.field] = conflict.latest!;
    }
    conflictSnapshot.current = undefined;
    setConflicts([]);
    prepareMerge(latest);
    await flush();
    openDrawer(null);
  }
  async function restoreDraft() {
    if (!recovery) return;
    draft.current = recovery;
    setRecovery(null);
    refreshDraft((x) => x + 1);
    await retryDraft();
  }
  function discardDraft() {
    draft.current = null;
    setRecovery(null);
    setConflicts([]);
    conflictSnapshot.current = undefined;
    persistDraft();
    setError('');
    refreshDraft((x) => x + 1);
  }
  function dismissPollError() {
    pollHealthRef.current = { ...pollHealthRef.current, dismissed: true };
    setPollHealth(pollHealthRef.current);
  }
  function composition(id: string, active: boolean) {
    if (active) {
      composingNodes.current.add(id);
      clearTimeout(saveTimer.current);
    } else {
      composingNodes.current.delete(id);
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        if (!conflictSnapshot.current) void perform(flush);
      }, 550);
    }
  }
  async function startFromEmpty(action: typeof startAction) {
    if (locked || busy || starting.current || creating || recoveryRef.current) return;
    setMenu(false);
    if (!snapshot || action === 'new') {
      setNewTitle('');
      setStartAction(action);
      setCreating(true);
      return;
    }
    starting.current = true;
    try {
      await beginDocument(action, snapshot);
    } finally {
      starting.current = false;
    }
  }
  async function beginDocument(action: typeof startAction, s: Snapshot) {
    if (action === 'manual') await add(true, s.root);
    if (action === 'structure')
      await requestAi(
        'expand',
        [s.root.id],
        t('outlinePrompt').replace('{title}', () => s.root.title),
        'one',
      );
    if (action === 'paste') {
      openDrawer('paste');
    }
  }
  async function createDocument() {
    if (!creating || starting.current || locked || !newTitle.trim()) return;
    starting.current = true;
    try {
      const s = await switchDocument(() => call<Snapshot>('create', { title: newTitle.trim() }));
      if (!s) return;
      setCreating(false);
      setNewTitle('');
      await beginDocument(startAction, s);
    } finally {
      starting.current = false;
    }
  }
  async function saveReviewDraft(pin: RevisionPin, value?: SuggestionEdit, baseDigest?: string) {
    const s = snapshot!;
    if (!currentDocument()) throw Error(t('quoteStale'));
    const result = await call<ReviewDraft>('review-draft', {
      path: s.path,
      revision: s.revision,
      token: s.token,
      ...pin,
      value,
      baseDigest,
    });
    if (currentDocument()) {
      stateEpoch.current++;
      knownDrafts.current = undefined;
      setReviewDrafts((old) => [
        ...old.filter((r) => r.batchId !== pin.batchId || r.id !== pin.id),
        result,
      ]);
    }
    return result;
  }
  function paragraphOriginal(nodeId: string, ordinal: number, s = snapshot) {
    const node = s && flatten(s.root).find(({ node }) => node.id === nodeId)?.node;
    return node ? naturalParagraphs(node.body)[ordinal - 1]?.text : undefined;
  }
  async function issueQuote(
    nodeId: string,
    kind: 'quote' | 'reference' | 'review-quote' = 'quote',
    paragraph?: number,
    pin?: RevisionPin,
    original = paragraph === undefined ? undefined : paragraphOriginal(nodeId, paragraph),
  ) {
    const valid = () =>
      currentDocument() &&
      (paragraph === undefined ||
        (original !== undefined &&
          paragraphOriginal(nodeId, paragraph, snapRef.current) === original));
    if (!valid()) throw new Error(t('quoteStale'));
    await flush();
    const s = snapRef.current;
    if (!s || !valid()) throw new Error(t('quoteStale'));
    const quote = await call<BlockQuote>(kind, {
      ...pin,
      path: s.path,
      nodeId,
      paragraph,
      scheme: profileFor(s, preferencesRef.current.scheme).scheme,
      token: s.token,
      revision: s.revision,
    });
    if (!currentDocument(s.token)) throw new Error(t('quoteStale'));
    return quote;
  }
  async function saveAs() {
    setMenu(false);
    await flush();
    const s = snapRef.current!;
    const { text } = await call<{ text: string }>('manuscript', {
      revision: s.revision,
      token: s.token,
    });
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = s.path.split(/[/\\]/).pop()!;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  async function copyText() {
    await reviewExport('text');
  }
  function fullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void editorElement.current?.requestFullscreen?.();
  }
  async function cancelAi() {
    const result = await call<{ locked: boolean }>('cancel');
    setLocked(result.locked);
  }
  async function retryStaging() {
    const result = await call<{ locked: boolean }>('retry-staging');
    setLocked(result.locked);
  }
  return {
    newHeading,
    headingText,
    finishHeading,
    onboarding,
    openHelp,
    closeHelp,
    call,
    sessionId,
    t,
    errorDetails,
    exportFilename,
    setExportFilename,
    suggestions,
    expansion,
    setExpansion,
    setExpansionDefault,
    setDocumentProfile,
    profile,
    pageStyle,
    startFromEmpty,
    startAction,
    moveTo,
    moveDestinations,
    aiReviewCount,
    review,
    activatePaperSuggestion,
    reviewRequest,
    setReviewRequest,
    reviewDrafts,
    saveReviewDraft,
    revising,
    paperMode,
    setPaperMode,
    decideAi,
    fixHealth,
    pasteText,
    setPasteText,
    pastePreview,
    setPastePreview,
    previewPaste,
    insertPaste,
    pasteFeedback,
    switchPaste,
    reviewPaste,
    savePasteSection,
    dismissPaste,
    clipboardBlocked,
    menuPaste,
    paste,
    revisionData,
    onlyChanges,
    setOnlyChanges,
    reviewRevisions,
    exportRevisions,
    navigation,
    drawer,
    openDrawer,
    menu,
    setMenu,
    outlineEditing,
    setOutlineEditing,
    integrityAlert,
    queueNotice,
    activeIds,
    focusProps,
    focusWithoutSelecting,
    clearSelection,
    replaceSelection,
    rememberSelection,
    selectLevel,
    selectChapter,
    exportReview,
    reviewExport,
    completeExport,
    diagnostics,
    setDiagnostics,
    numbers,
    labels,
    references,
    language,
    setLanguage,
    snapshot,
    files,
    locked,
    busy,
    error,
    setError,
    select,
    drop,
    notice,
    setNotice,
    selection,
    targets,
    nodeTargets,
    targetLine,
    targetName,
    setSelection,
    view,
    setView,
    instruction,
    instructionFor,
    generateTitles,
    autoTitleIds,
    setInstruction,
    creating,
    setCreating,
    newTitle,
    setNewTitle,
    scheme,
    setScheme,
    fontSize,
    setFontSize,
    articleTitle,
    setArticleTitle,
    editing,
    setEditing,
    zoom,
    rows,
    visible,
    layout,
    cardSource,
    selected,
    editorElement,
    board,
    inputFile,
    hasDraft: !!draft.current,
    value,
    edit,
    flush,
    change,
    perform,
    keydown,
    nodeProps,
    nodeInteraction,
    history,
    ai,
    add,
    remove,
    download,
    importFile,
    selectDocument,
    createDocument,
    retryDraft,
    discardDraft,
    issueQuote,
    paragraphOriginal,
    currentDocument,
    documentGeneration: renderEpoch,
    inlineEdit,
    beginInlineEdit,
    setInlineEdit,
    saveInline,
    saveAs,
    copyText,
    fullscreen,
    center,
    cancelAi,
    retryStaging,
    focusNode,
    locateSelection,
    moveSelected,
    searchOpen,
    setSearchOpen,
    search,
    setSearch,
    recovery,
    restoreDraft,
    conflicts,
    resolveConflicts,
    conflictToken: conflictSnapshot.current?.token,
    pollHealth,
    dismissPollError,
    loaded,
    localError,
    composition,
    composingNodes,
    arabic,
    setArabic,
    nodeStatus,
    nodeStatusKey: statuses,
    stateProps,
  };
}
export type EditorController = ReturnType<typeof useEditor>;
