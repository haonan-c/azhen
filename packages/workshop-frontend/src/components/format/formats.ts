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

// The glyph for each key in the shared `OUTPUT_ICONS` vocabulary.
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

// Which wireframe illustrates a format. Derived from the icon rather than picked separately, so
// the two can't disagree; icons depicting the same artefact (a page vs. a notebook) share one.
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

// How a gadget with no declared format is shown. Also the fallback for an icon this build doesn't
// know, which is normal: a deployment can serve a format newer than the browser's cached bundle.
export const GENERIC_OUTPUT: BlueprintOutput = {
  id: 'app',
  noun: 'App',
  plural: 'Apps',
  icon: 'appWindow',
}

const BUNDLED_FORMATS: Record<string, {
  noun: string
  plural: string
  icon: OutputIcon
  localizedNoun: () => string
  localizedPlural: () => string
}> = {
  document: {
    noun: 'Doc',
    plural: 'Docs',
    icon: 'fileText',
    localizedNoun: messages.output_format_document,
    localizedPlural: messages.output_format_document_plural,
  },
  presentation: {
    noun: 'Slides',
    plural: 'Slides',
    icon: 'presentation',
    localizedNoun: messages.output_format_slides,
    localizedPlural: messages.output_format_slides_plural,
  },
  spreadsheet: {
    noun: 'Sheet',
    plural: 'Sheets',
    icon: 'table',
    localizedNoun: messages.output_format_spreadsheet,
    localizedPlural: messages.output_format_spreadsheet_plural,
  },
}

function bundledFormat(output: BlueprintOutput) {
  const bundled = BUNDLED_FORMATS[output.id]
  return bundled?.noun === output.noun
      && bundled.plural === output.plural
      && bundled.icon === output.icon
    ? bundled
    : undefined
}

// Resolve what to draw for a (possibly absent, possibly unrecognized) declared format.
export function formatOf(output?: BlueprintOutput): BlueprintOutput {
  if (!output || !Object.hasOwn(FORMAT_ICONS, output.icon)) return GENERIC_OUTPUT
  return output
}

// The bundled declarations are first-party copy. Match their full presentation signature so a
// custom format that merely shares a grouping id keeps its author-provided name unchanged.
export function formatNoun(output?: BlueprintOutput): string {
  if (!output) return messages.workspace_generic_app()
  const bundled = bundledFormat(output)
  if (bundled) return bundled.localizedNoun()
  const format = formatOf(output)
  return format === GENERIC_OUTPUT ? messages.workspace_generic_app() : format.noun
}

export function formatPlural(output?: BlueprintOutput): string {
  if (!output) return messages.output_format_app_plural()
  const bundled = bundledFormat(output)
  if (bundled) return bundled.localizedPlural()
  const format = formatOf(output)
  return format === GENERIC_OUTPUT ? messages.output_format_app_plural() : format.plural
}

export function wireframeOf(output?: BlueprintOutput): FormatWireframe {
  return WIREFRAME_FOR_ICON[formatOf(output).icon]
}

// The bundled formats have localized first-party names. Deployment overrides and custom formats
// keep the exact name supplied by their author.
export function formatOfferNoun(format: OutputFormatOffer): string {
  if (format.blueprintId === 'format.document' && format.output.noun === 'Doc') {
    return messages.output_format_document()
  }
  if (format.blueprintId === 'format.slides' && format.output.noun === 'Slides') {
    return messages.output_format_slides()
  }
  if (format.blueprintId === 'format.spreadsheet' && format.output.noun === 'Sheet') {
    return messages.output_format_spreadsheet()
  }
  return format.output.noun
}
