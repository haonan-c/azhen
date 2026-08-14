// How an output format is drawn: which glyph, which nouns, which wireframe. The server sends a
// blueprint's `BlueprintOutput` declaration; this module is the only place that maps it to pixels.
//
// Icons are a closed set (`OUTPUT_ICONS` in the shared API) so a free-form name can't make a
// deployment look wrong. Only the key crosses the wire; the glyphs live here.

import {
  FileText,
  GridNine,
  Presentation,
  AppWindow,
  FlowArrow,
  Kanban,
  ChartBar,
  Table,
  Notebook,
  ListChecks,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react'
import type { BlueprintOutput, OutputFormatOffer, OutputIcon } from '@gadgets/workshop-shared/api'
import { m as messages } from '../../paraglide/messages.js'

/** The glyph for each key in the shared `OUTPUT_ICONS` vocabulary. */
export const FORMAT_ICONS = {
  fileText: FileText,
  gridNine: GridNine,
  presentation: Presentation,
  appWindow: AppWindow,
  flowArrow: FlowArrow,
  kanban: Kanban,
  chartBar: ChartBar,
  table: Table,
  notebook: Notebook,
  listChecks: ListChecks,
} satisfies Record<OutputIcon, PhosphorIcon>

/**
 * Which wireframe illustrates a format. Derived from the icon rather than picked separately, so
 * the two can't disagree; icons depicting the same artefact (a page vs. a notebook) share one.
 */
export type FormatWireframe = 'page' | 'grid' | 'slide' | 'window' | 'list' | 'board' | 'chart'

const WIREFRAME_FOR_ICON: Record<OutputIcon, FormatWireframe> = {
  fileText: 'page',
  notebook: 'page',
  gridNine: 'grid',
  table: 'grid',
  presentation: 'slide',
  chartBar: 'chart',
  appWindow: 'window',
  flowArrow: 'board',
  kanban: 'board',
  listChecks: 'list',
}

/**
 * How a gadget with no declared format is shown. Also the fallback for an icon this build doesn't
 * know, which is normal: a deployment can serve a format newer than the browser's cached bundle.
 */
export const GENERIC_OUTPUT: BlueprintOutput = {
  id: 'app',
  noun: 'App',
  plural: 'Apps',
  icon: 'appWindow',
}

const BUNDLED_FORMATS: Array<{
  id: string
  blueprintId: string
  noun: string
  plural: string
  icon: OutputIcon
  localizedNoun: () => string
  localizedPlural: () => string
}> = [
  {
    id: 'document',
    blueprintId: 'format.document',
    noun: 'Doc',
    plural: 'Docs',
    icon: 'fileText',
    localizedNoun: messages.output_format_document,
    localizedPlural: messages.output_format_document_plural,
  },
  {
    id: 'presentation',
    blueprintId: 'format.slides',
    noun: 'Slides',
    plural: 'Slides',
    icon: 'presentation',
    localizedNoun: messages.output_format_slides,
    localizedPlural: messages.output_format_slides_plural,
  },
  {
    id: 'spreadsheet',
    blueprintId: 'format.spreadsheet',
    noun: 'Sheet',
    plural: 'Sheets',
    icon: 'table',
    localizedNoun: messages.output_format_spreadsheet,
    localizedPlural: messages.output_format_spreadsheet_plural,
  },
]

function bundledFormat(output: BlueprintOutput) {
  return BUNDLED_FORMATS.find((bundled) => bundled.id === output.id
    && bundled.noun === output.noun
    && bundled.plural === output.plural
    && bundled.icon === output.icon)
}

/** Resolve what to draw for a (possibly absent, possibly unrecognized) declared format. */
export function formatOf(output?: BlueprintOutput): BlueprintOutput {
  if (!output || !Object.hasOwn(FORMAT_ICONS, output.icon)) return GENERIC_OUTPUT
  return output
}

/** The localized noun for a declared format, preserving custom author-provided names. */
export function formatNoun(output?: BlueprintOutput): string {
  if (!output) return messages.workspace_generic_app()
  const bundled = bundledFormat(output)
  if (bundled) return bundled.localizedNoun()
  const format = formatOf(output)
  return format === GENERIC_OUTPUT ? messages.workspace_generic_app() : format.noun
}

/** The localized plural noun for a declared format, preserving custom author-provided names. */
export function formatPlural(output?: BlueprintOutput): string {
  if (!output) return messages.output_format_app_plural()
  const bundled = bundledFormat(output)
  if (bundled) return bundled.localizedPlural()
  const format = formatOf(output)
  return format === GENERIC_OUTPUT ? messages.output_format_app_plural() : format.plural
}

/** Resolve the visual wireframe associated with a declared format. */
export function wireframeOf(output?: BlueprintOutput): FormatWireframe {
  return WIREFRAME_FOR_ICON[formatOf(output).icon]
}

/** Resolve the localized noun shown for a format offer. */
export function formatOfferNoun(format: OutputFormatOffer): string {
  const bundled = BUNDLED_FORMATS.find((candidate) =>
    candidate.blueprintId === format.blueprintId && candidate.noun === format.output.noun)
  return bundled?.localizedNoun() ?? format.output.noun
}
