import React from 'react';
import { composing } from '../keyboard.ts';
import { Icon } from './Icon.tsx';
import type { CopyKey } from '../../locales.ts';
import { actionTargetIds, type AiTargets } from '../instruction.ts';
import type { EditorController } from '../hooks/useEditor.ts';
export interface WithEditor {
  editor: EditorController;
}
export function TargetNames({ editor: c }: WithEditor) {
  return (
    <>
      <p className="mw-target-names" tabIndex={0}>
        {c.targetLine('selectionNames', c.targets.ids)}
      </p>
      {c.targets.leadId && (
        <p className="mw-target-names" tabIndex={0}>
          {c.targetLine('leadNames', actionTargetIds(c.targets, 'polish'))}
        </p>
      )}
    </>
  );
}
export function SelectionChips({ editor: c }: WithEditor) {
  return (
    <>
      {c.targetLine('selectionNames', [], c.targets.ids.length)}
      {c.targets.ids.map((id, index) => (
        <React.Fragment key={id}>
          {index > 0 && <span className="mw-chip-separator"> · </span>}
          <span className="mw-target-chip">{c.targetName(id)}</span>
        </React.Fragment>
      ))}
    </>
  );
}
export function InstructionForm({
  editor: c,
  nodeScope,
  beforeSend,
  focusInput = true,
}: WithEditor & { nodeScope?: AiTargets; beforeSend?: () => void; focusInput?: boolean }) {
  const scope = nodeScope ?? c.targets;
  const text = c.instructionFor(scope);
  return (
    <form
      className="mw-custom-instruction"
      onSubmit={(event) => {
        event.preventDefault();
        if (!text.trim() || !scope.ids.length || c.busy || c.locked) return;
        beforeSend?.();
        void c.perform(() => c.ai('polish', { nodeScope }));
      }}
    >
      <div className="mw-prompt-box">
        <textarea
          autoFocus={focusInput}
          rows={2}
          aria-label={c.t('instruction')}
          placeholder={c.t(nodeScope ? 'instructionHint' : 'writingPlaceholder')}
          value={text}
          disabled={c.busy || c.locked}
          onChange={(event) => c.setInstruction(event.target.value, scope)}
          onKeyDown={(event) => {
            if (
              nodeScope ||
              event.key !== 'Enter' ||
              event.shiftKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.altKey ||
              composing(event.nativeEvent)
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) event.currentTarget.form?.requestSubmit();
          }}
        />
        <div className="mw-prompt-actions">
          {!nodeScope && <small>{c.t('writingKeys')}</small>}
          <button
            className="mw-primary"
            type="submit"
            title={c.t('sendToAi')}
            aria-label={c.t('sendToAi')}
            disabled={!text.trim() || !scope.ids.length || c.busy || c.locked}
          >
            <Icon name="arrowUp" />
          </button>
        </div>
      </div>
      <small>{c.t(nodeScope ? 'stagedOnly' : 'writingStaged')}</small>
    </form>
  );
}
export function ActionButton({
  editor: c,
  label,
  action,
  disabled = false,
  queueable = false,
  autoFocus,
  icon,
  className,
}: WithEditor & {
  label: CopyKey;
  action: () => void | Promise<void>;
  disabled?: boolean;
  queueable?: boolean;
  autoFocus?: boolean;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      autoFocus={autoFocus}
      className={className}
      title={c.t(label)}
      aria-label={c.t(label)}
      disabled={disabled || (c.busy && !queueable)}
      onClick={() =>
        void c.perform(async () => {
          await action();
        })
      }
    >
      {icon ?? c.t(label)}
    </button>
  );
}
export function EditToolbar({ editor: c }: WithEditor) {
  const disabled = !c.selected || c.locked;
  return (
    <div className="mw-editbar">
      <ActionButton
        editor={c}
        label="addChild"
        action={() => c.add(true)}
        disabled={disabled || c.selected?.kind === 'preamble'}
      />
      <ActionButton
        editor={c}
        label="addSibling"
        action={() => c.add(false)}
        disabled={disabled || c.selected?.id === c.snapshot?.root.id}
      />
      <ActionButton
        editor={c}
        label="remove"
        action={c.remove}
        disabled={disabled || c.selected?.id === c.snapshot?.root.id}
      />
      <ActionButton editor={c} label="up" action={() => c.moveSelected(-1)} disabled={disabled} />
      <ActionButton editor={c} label="down" action={() => c.moveSelected(1)} disabled={disabled} />
      <select
        aria-label={c.t('parent')}
        value=""
        disabled={disabled || c.selection.includes(c.snapshot!.root.id)}
        onChange={(e) => {
          const parentId = e.currentTarget.value;
          void c.perform(() => c.moveTo(parentId));
        }}
      >
        <option value="" disabled>
          {c.t('parent')}…
        </option>
        {c.moveDestinations(c.selection).map((row) => (
          <option value={row.node.id} key={row.node.id}>
            {'·'.repeat(row.depth)} {row.node.title}
          </option>
        ))}
      </select>
    </div>
  );
}
