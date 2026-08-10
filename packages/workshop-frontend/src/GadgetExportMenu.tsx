import { useState } from 'react'
import { DropdownMenu, Tooltip, useKumoToastManager } from '@cloudflare/kumo'
import { DownloadSimple } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { GadgetClient } from '@gadgets/workshop-shared/api'
import { WorkshopIconButton } from './components/WorkshopControls'
import { makeExportFilename, saveStreamToFile } from './fileTransfers'
import { m as messages } from './paraglide/messages.js'

type Props = {
  gadget: RpcStub<GadgetClient> | null
  gadgetTitle: string
  chatId?: number
  disabled?: boolean
}

type ExportFormat = 'docx' | 'pdf'

const EXPORT_FILE_TYPES = {
  docx: { extension: '.docx' },
  pdf: { extension: '.pdf' },
} as const

export default function GadgetExportMenu({ gadget, gadgetTitle, chatId, disabled }: Props) {
  const [exporting, setExporting] = useState(false)
  const toasts = useKumoToastManager()

  const download = async (format: ExportFormat) => {
    if (!gadget || exporting) return

    setExporting(true)
    try {
      const fileType = EXPORT_FILE_TYPES[format]
      await saveStreamToFile(
        () => format === 'docx' ? gadget.exportDocx(chatId) : gadget.exportPdf(chatId),
        makeExportFilename(gadgetTitle, fileType.extension),
      )
    } catch (error) {
      console.error(`Failed to export Gadget as ${format.toUpperCase()}:`, error)
      toasts.add({
        title: messages.workspace_export_failed({ format: format.toUpperCase() }),
        variant: 'error',
      })
    } finally {
      setExporting(false)
    }
  }

  return (
    <Tooltip
      content={exporting ? messages.workspace_export_exporting() : messages.workspace_export_document()}
      asChild
    >
      <span className="relative inline-flex">
        <DropdownMenu>
          <DropdownMenu.Trigger
            render={(
              <WorkshopIconButton
                aria-label={messages.workspace_export_document()}
                disabled={disabled || !gadget || exporting}
              >
                <DownloadSimple size={17} />
              </WorkshopIconButton>
            )}
          />
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="themed-floating-shadow !z-[1100] !min-w-[180px] rounded-lg border border-kumo-line bg-kumo-base p-1"
          >
            <DropdownMenu.Item
              onClick={() => { void download('docx') }}
              className="!h-auto rounded-md !px-2.5 !py-1.5 text-[12px] leading-4 text-kumo-default transition-colors data-highlighted:bg-kumo-tint"
            >
              {messages.workspace_export_word()}
            </DropdownMenu.Item>
            <DropdownMenu.Item
              onClick={() => { void download('pdf') }}
              className="!h-auto rounded-md !px-2.5 !py-1.5 text-[12px] leading-4 text-kumo-default transition-colors data-highlighted:bg-kumo-tint"
            >
              {messages.workspace_export_pdf()}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu>
        {exporting && (
          <span className="pointer-events-none absolute bottom-0 left-1 right-1 h-0.5 overflow-hidden rounded-full bg-kumo-fill">
            <span className="absolute inset-y-0 w-1/3 bg-kumo-brand animate-[thinking_1.5s_ease-in-out_infinite]" />
          </span>
        )}
      </span>
    </Tooltip>
  )
}
