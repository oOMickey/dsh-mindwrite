import { z } from 'zod';
import { readMarker } from './numbering.ts';

const importId = z.string().min(1).max(160);
const importLabel = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[^\r\n]+$/u);
export const importNumberingSchema = z.object({
  prefixes: z
    .record(
      importId,
      importLabel.refine((s) => readMarker(s)?.prefix === s),
    )
    .refine((entries) => Object.keys(entries).length <= 3000)
    .optional(),
  warnings: z
    .array(
      z.object({
        paragraph: z.number().int().positive(),
        nodeId: importId,
        code: z.string().min(1).max(64),
        marker: importLabel,
        related: importLabel.optional(),
      }),
    )
    .max(20000)
    .optional(),
});
export type ImportNumbering = z.infer<typeof importNumberingSchema>;

export const sourceNumberSchema = z.object({
  unit: z.enum(['chapter', 'article', 'item', 'subitem']),
  number: z.number().int().positive().max(10000),
});
export type SourceNumber = z.infer<typeof sourceNumberSchema>;
export const referenceSchema = z.object({
  id: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  text: z.string().max(200),
  unit: z.enum(['chapter', 'article']),
  number: z.number().int().positive(),
  item: z.number().int().positive().optional(),
  needsReview: z.boolean().optional(),
  targets: z.array(z.object({ id: z.string(), itemId: z.string().optional() })).max(3000),
});
export type BoundReference = z.infer<typeof referenceSchema>;
export const importReportSchema = z.object({
  source: z.enum(['docx', 'markdown']),
  chapters: z.number().int().nonnegative(),
  articles: z.number().int().nonnegative(),
  preambleParagraphs: z.number().int().nonnegative(),
  revisions: z.object({ accepted: z.literal(true), insertions: z.number(), deletions: z.number() }),
  nativeListItems: z.number().int().nonnegative().optional(),
  tableCount: z.number().int().nonnegative().optional(),
  tables: z
    .array(
      z.object({
        index: z.number().int().positive(),
        nodeId: z.string(),
        rows: z.number().int().nonnegative(),
        columns: z.number().int().nonnegative(),
        count: z.number().int().positive(),
        method: z.enum(['column-values', 'original-note']),
        reason: z.string(),
      }),
    )
    .max(3000)
    .optional(),
  losses: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('word-list'),
          paragraph: z.number().int().positive(),
          reason: z.enum(['missing-definition', 'unsupported-pattern']),
          marker: z.string(),
        }),
        z.object({
          kind: z.literal('heading'),
          paragraph: z.number().int().positive(),
          reason: z.enum(['missing-parent', 'numbering-conflict']),
          sourceLevel: z.number().int().positive(),
          targetLevel: z.number().int().positive(),
          marker: z.string(),
        }),
      ]),
    )
    .optional(),
  issues: z
    .array(
      z.object({
        code: z.enum([
          'duplicate-article',
          'missing-article',
          'duplicate-chapter',
          'missing-chapter',
          'unfinished',
        ]),
        numbers: z.array(z.number()).max(10000),
        nodeIds: z.array(z.string()).max(3000),
      }),
    )
    .max(6000),
});
export type ImportReport = z.infer<typeof importReportSchema>;
