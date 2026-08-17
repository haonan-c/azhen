import { useState, useEffect } from 'react'
import { Dialog, Button, Input, Select, SensitiveInput, Collapsible, useKumoToastManager } from '@cloudflare/kumo'
import { AiModelConfig, AiModelProvider, AiGatewayInfo, DIRECT_ONLY_AI_PROVIDERS, SUGGESTED_MODELS } from '@gadgets/workshop-shared/api'
import { m as messages } from './paraglide/messages.js'

interface AddModelModalProps {
  visible: boolean
  onCancel: () => void
  onSuccess: () => void
  onAddModel: (name: string, config: AiModelConfig) => Promise<void>
  aiConfig: AiGatewayInfo | null
}

type SelectionType =
  | { type: 'suggested', provider: AiModelProvider, modelId: string, displayName: string }
  | { type: 'custom', provider: AiModelProvider }

const PROVIDER_LABELS: Record<AiModelProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  cloudflare: 'Cloudflare Workers AI',
  deepseek: 'DeepSeek',
  ollama: 'Ollama',
}

// Placeholder hinting at the shape of each provider's API token.
const API_TOKEN_PLACEHOLDERS: Record<AiModelProvider, string> = {
  anthropic: 'sk-ant-...',
  openai: 'sk-...',
  google: 'AIza...',
  cloudflare: '',
  deepseek: 'sk-...',
  ollama: '',
}

function apiTokenPlaceholder(provider: AiModelProvider): string {
  if (provider === 'cloudflare') return messages.add_model_cloudflare_token_placeholder()
  if (provider === 'ollama') return messages.add_model_optional_placeholder()
  return API_TOKEN_PLACEHOLDERS[provider]
}

// Example used in the custom-model placeholders for providers that have no suggested models
// (currently Ollama, which serves whatever the user has pulled locally).
const FALLBACK_EXAMPLE_MODEL = { modelId: 'gemma4:31b', name: 'Gemma 4 31B' }

// Pick an example model to show in the custom-model placeholders for the given provider.
function exampleModel(provider: AiModelProvider): { modelId: string, name: string } {
  const first = Object.entries(SUGGESTED_MODELS[provider])[0]
  return first ? { modelId: first[0], name: first[1].name } : FALLBACK_EXAMPLE_MODEL
}

// Encode a selection into a string value for the Select component.
function encodeSelection(provider: AiModelProvider, modelId?: string): string {
  return modelId ? `${provider}:${modelId}` : `other-${provider}`
}

// Decode a Select value back into a SelectionType.
function decodeSelection(value: string): SelectionType {
  if (value.startsWith('other-')) {
    return { type: 'custom', provider: value.substring(6) as AiModelProvider }
  }
  const colonIndex = value.indexOf(':')
  const provider = value.substring(0, colonIndex) as AiModelProvider
  const modelId = value.substring(colonIndex + 1)
  const displayName = SUGGESTED_MODELS[provider][modelId].name
  return { type: 'suggested', provider, modelId, displayName }
}

// Build the flat list of options for the Select dropdown.
function buildOptions(gatewayMode: boolean, enabledProviders: Set<string> | null) {
  const options: { value: string; label: string; provider: string }[] = []
  const providerOrder = Object.keys(SUGGESTED_MODELS) as AiModelProvider[]

  for (const provider of providerOrder) {
    const directOnly = DIRECT_ONLY_AI_PROVIDERS.has(provider)
    if (enabledProviders && !enabledProviders.has(provider) && !directOnly) continue

    // Gateway-backed suggested models are already built in. Direct-only suggested models still
    // need to be offered because they use the user's own credentials.
    if (!gatewayMode || directOnly) {
      for (const [modelId, model] of Object.entries(SUGGESTED_MODELS[provider])) {
        options.push({
          value: encodeSelection(provider, modelId),
          label: model.name,
          provider,
        })
      }
    }

    options.push({
      value: encodeSelection(provider),
      label: messages.add_model_other_provider({
        provider: PROVIDER_LABELS[provider] || provider,
      }),
      provider,
    })
  }

  return options
}

export default function AddModelModal({ visible, onCancel, onSuccess, onAddModel, aiConfig }: AddModelModalProps) {
  const toasts = useKumoToastManager()

  const [loading, setLoading] = useState(false)
  const [selection, setSelection] = useState<SelectionType | null>(null)
  const [selectValue, setSelectValue] = useState<string | undefined>(undefined)

  // Form fields (used for custom models)
  const [modelId, setModelId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [accountId, setAccountId] = useState('')
  const [apiUrl, setApiUrl] = useState('')

  // Validation errors
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Advanced settings collapsible state
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const gatewayMode = aiConfig?.enabled === true
  const enabledProviders: Set<string> | null = gatewayMode
    ? new Set(aiConfig.enabledProviders)
    : null
  const usesDirectCredentials = !gatewayMode ||
    (selection !== null && DIRECT_ONLY_AI_PROVIDERS.has(selection.provider))

  // Reset all state when dialog closes
  useEffect(() => {
    if (!visible) {
      setSelection(null)
      setSelectValue(undefined)
      setModelId('')
      setDisplayName('')
      setApiToken('')
      setAccountId('')
      setApiUrl('')
      setErrors({})
      setAdvancedOpen(false)
    }
  }, [visible])

  const handleModelSelect = (value: string) => {
    setSelectValue(value)
    setErrors({})
    const sel = decodeSelection(value)
    setSelection(sel)

    if (sel.type === 'custom') {
      setModelId('')
      setDisplayName('')
    } else {
      setModelId(sel.modelId)
      setDisplayName(sel.displayName)
    }
    setApiToken('')
    setAccountId('')
    setApiUrl(sel.provider === 'ollama' ? 'http://localhost:11434' : '')
  }

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {}

    if (!selection) {
      newErrors.selection = gatewayMode
        ? messages.add_model_validation_provider()
        : messages.add_model_validation_model()
    }

    if (selection?.type === 'custom') {
      if (!modelId.trim()) newErrors.modelId = messages.add_model_validation_model_id()
      if (!displayName.trim()) {
        newErrors.displayName = messages.add_model_validation_display_name()
      }
    }

    const isOllama = selection?.provider === 'ollama'
    const isCloudflare = selection?.provider === 'cloudflare'
    if (usesDirectCredentials && selection && !isOllama && !apiToken.trim()) {
      newErrors.apiToken = messages.add_model_validation_api_token()
    }

    if (usesDirectCredentials && isCloudflare && !accountId.trim()) {
      newErrors.accountId = messages.add_model_validation_account_id()
    }

    if (usesDirectCredentials && isOllama && !apiUrl.trim()) {
      newErrors.apiUrl = messages.add_model_validation_api_url()
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async () => {
    if (!validate()) return

    setLoading(true)
    try {
      const isSuggested = selection!.type === 'suggested'
      const finalModelId = isSuggested ? selection!.modelId : modelId.trim()
      const finalDisplayName = isSuggested ? selection!.displayName : displayName.trim()

      const config: AiModelConfig = {
        provider: selection!.provider,
        model: finalModelId,
        apiToken: usesDirectCredentials ? apiToken.trim() : '',
        ...(usesDirectCredentials && accountId.trim() && { accountId: accountId.trim() }),
        ...(usesDirectCredentials && apiUrl.trim() && { apiUrl: apiUrl.trim() }),
      }

      await onAddModel(finalDisplayName, config)
      toasts.add({ title: messages.add_model_success(), variant: 'success' })
      onSuccess()
    } catch (error: any) {
      console.error('Failed to add model:', error)
      toasts.add({ title: messages.add_model_error(), variant: 'error' })
    } finally {
      setLoading(false)
    }
  }

  const options = buildOptions(gatewayMode, enabledProviders)
  const showCustomFields = selection?.type === 'custom'
  const example = selection ? exampleModel(selection.provider) : null
  const isOllama = selection?.provider === 'ollama'
  const isCloudflare = selection?.provider === 'cloudflare'
  const showCredentials = usesDirectCredentials

  // Group options by provider for rendering with visual separators.
  const groupedOptions: { provider: string; items: typeof options }[] = []
  for (const opt of options) {
    const last = groupedOptions[groupedOptions.length - 1]
    if (last && last.provider === opt.provider) {
      last.items.push(opt)
    } else {
      groupedOptions.push({ provider: opt.provider, items: [opt] })
    }
  }

  return (
    <Dialog.Root open={visible} onOpenChange={(open) => { if (!open) onCancel() }}>
      <Dialog className="p-6" size="lg">
        <Dialog.Title className="text-lg font-semibold mb-4">
          {messages.add_model_title()}
        </Dialog.Title>

        <div className="space-y-4">
          {/* Model / Provider selection */}
          <Select
            label={gatewayMode ? messages.add_model_select_provider() : messages.add_model_select_model()}
            className="w-full text-sm"
            placeholder={gatewayMode ? messages.add_model_choose_provider() : messages.add_model_choose_model()}
            value={selectValue}
            onValueChange={(v) => handleModelSelect(v as string)}
            error={errors.selection}
            renderValue={(v) => {
              const opt = options.find(o => o.value === v)
              return opt?.label ?? String(v)
            }}
          >
            {groupedOptions.map((group, groupIndex) => (
              <div key={group.provider}>
                {groupIndex > 0 && (
                  <div className="h-px bg-kumo-line my-1 mx-2" />
                )}
                <div className="px-3 py-1.5 text-xs font-medium text-kumo-subtle select-none">
                  {PROVIDER_LABELS[group.provider as AiModelProvider] || group.provider}
                </div>
                {group.items.map(opt => (
                  <Select.Option key={opt.value} value={opt.value}>
                    {opt.label}
                  </Select.Option>
                ))}
              </div>
            ))}
          </Select>

          {/* Custom model fields */}
          {showCustomFields && (
            <>
              <Input
                label={messages.add_model_model_id()}
                placeholder={messages.add_model_example({ example: example!.modelId })}
                description={messages.add_model_model_id_description({ example: example!.modelId })}
                value={modelId}
                onChange={(e) => { setModelId(e.target.value); setErrors(prev => ({ ...prev, modelId: '' })) }}
                error={errors.modelId}
                variant={errors.modelId ? 'error' : 'default'}
              />

              <Input
                label={messages.add_model_display_name()}
                placeholder={messages.add_model_example({ example: example!.name })}
                description={messages.add_model_display_name_description()}
                value={displayName}
                onChange={(e) => { setDisplayName(e.target.value); setErrors(prev => ({ ...prev, displayName: '' })) }}
                error={errors.displayName}
                variant={errors.displayName ? 'error' : 'default'}
              />
            </>
          )}

          {/* Cloudflare account ID (the Workers AI REST endpoint is account-scoped) */}
          {showCredentials && isCloudflare && (
            <Input
              label={messages.add_model_cloudflare_account_id()}
              placeholder={messages.add_model_example({
                example: '0123456789abcdef0123456789abcdef',
              })}
              description={messages.add_model_cloudflare_account_description()}
              value={accountId}
              onChange={(e) => { setAccountId(e.target.value); setErrors(prev => ({ ...prev, accountId: '' })) }}
              error={errors.accountId}
              variant={errors.accountId ? 'error' : 'default'}
            />
          )}

          {/* API Token */}
          {showCredentials && selection && (
            <SensitiveInput
              label={messages.add_model_api_token()}
              placeholder={apiTokenPlaceholder(selection.provider)}
              description={
                isOllama
                  ? messages.add_model_api_token_ollama_description()
                  : isCloudflare
                  ? messages.add_model_api_token_cloudflare_description()
                  : messages.add_model_api_token_provider_description({
                      provider: PROVIDER_LABELS[selection.provider],
                    })
              }
              value={apiToken}
              onValueChange={(v) => { setApiToken(v); setErrors(prev => ({ ...prev, apiToken: '' })) }}
              error={errors.apiToken}
              variant={errors.apiToken ? 'error' : 'default'}
            />
          )}

          {/* Ollama API URL (always visible for Ollama) */}
          {showCredentials && isOllama && (
            <Input
              label={messages.add_model_api_url()}
              placeholder="http://localhost:11434"
              description={messages.add_model_api_url_ollama_description()}
              value={apiUrl}
              onChange={(e) => { setApiUrl(e.target.value); setErrors(prev => ({ ...prev, apiUrl: '' })) }}
              error={errors.apiUrl}
              variant={errors.apiUrl ? 'error' : 'default'}
            />
          )}

          {/* Advanced Settings for non-Ollama, non-Cloudflare providers */}
          {showCredentials && selection && !isOllama && !isCloudflare && (
            <Collapsible.Root
              open={advancedOpen}
              onOpenChange={setAdvancedOpen}
            >
              <Collapsible.DefaultTrigger>
                {messages.add_model_advanced_settings()}
              </Collapsible.DefaultTrigger>
              <Collapsible.DefaultPanel>
                <Input
                  label={messages.add_model_api_url()}
                  placeholder="https://..."
                  description={messages.add_model_api_url_override_description()}
                  value={apiUrl}
                  onChange={(e) => setApiUrl(e.target.value)}
                />
              </Collapsible.DefaultPanel>
            </Collapsible.Root>
          )}
        </div>

        {/* Footer */}
        <div className="mt-6 flex justify-end gap-2">
          <Dialog.Close render={(props) => (
            <Button variant="secondary" {...props} disabled={loading}>
              {messages.add_model_cancel()}
            </Button>
          )} />
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={loading}
            disabled={!selection}
          >
            {messages.add_model_submit()}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
