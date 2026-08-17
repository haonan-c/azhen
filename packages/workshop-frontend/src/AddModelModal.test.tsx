// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope, unicorn/consistent-function-scoping */

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiGatewayInfo, AiModelConfig } from '@gadgets/workshop-shared/api'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', async () => {
  const { createContext, useContext } = await vi.importActual<typeof import('react')>('react')
  const SelectContext = createContext<(value: string) => void>(() => {})
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
      Close: ({ render }: { render: (props: ComponentProps<'button'>) => ReactNode }) =>
        <>{render({})}</>,
    },
  )
  const Select = Object.assign(
    ({ children, onValueChange, label }: {
      children: ReactNode
      onValueChange: (value: string) => void
      label: string
    }) => (
      <div aria-label={label}>
        <SelectContext.Provider value={onValueChange}>{children}</SelectContext.Provider>
      </div>
    ),
    {
      Option: ({ children, value }: { children: ReactNode, value: string }) => {
        const onValueChange = useContext(SelectContext)
        return (
          <button type="button" data-select-value={value} onClick={() => onValueChange(value)}>
            {children}
          </button>
        )
      },
    },
  )
  const Input = ({ label, description: _description, error, variant: _variant, ...props }:
    ComponentProps<'input'> & { label: string, description?: string, error?: string,
      variant?: string }) => (
    <label>{label}<input aria-label={label} {...props} />{error}</label>
  )
  const SensitiveInput = ({ label, description: _description, error, variant: _variant,
    onValueChange, ...props }:
    Omit<ComponentProps<'input'>, 'onChange'> & { label: string, description?: string,
      error?: string, variant?: string, onValueChange: (value: string) => void }) => (
    <label>
      {label}
      <input aria-label={label} {...props}
        onChange={(event) => onValueChange(event.target.value)} />
      {error}
    </label>
  )
  const Button = ({ children, loading: _loading, ...props }:
    ComponentProps<'button'> & { loading?: boolean }) => <button {...props}>{children}</button>
  const Collapsible = {
    Root: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DefaultTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DefaultPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  }
  return {
    Button,
    Collapsible,
    Dialog,
    Input,
    Select,
    SensitiveInput,
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
  }
})

import AddModelModal from './AddModelModal'

const AI_CONFIG: AiGatewayInfo = {
  enabled: true,
  enabledProviders: ['anthropic'],
}

function setInput(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setValue.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('AddModelModal direct-only providers in Gateway mode', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    window.history.replaceState({}, '', '/')
    root = undefined
    container = undefined
  })

  async function render() {
    const addModel = vi.fn<(name: string, config: AiModelConfig) => Promise<void>>(async () => {})
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <AddModelModal
          visible
          onCancel={() => {}}
          onSuccess={() => {}}
          onAddModel={addModel}
          aiConfig={AI_CONFIG}
        />,
      )
    })
    return { addModel, container }
  }

  it('offers DeepSeek and submits its direct credentials', async () => {
    const rendered = await render()
    expect(rendered.container.textContent).toContain('DeepSeek V4 Flash')
    expect(rendered.container.textContent).toContain('Other DeepSeek...')
    expect(rendered.container.textContent).toContain('Other Ollama...')

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>(
        '[data-select-value="deepseek:deepseek-v4-flash"]')!.click()
    })

    const tokenInput = rendered.container.querySelector<HTMLInputElement>('[aria-label="API Token"]')!
    const urlInput = rendered.container.querySelector<HTMLInputElement>('[aria-label="API URL"]')!
    await act(async () => {
      setInput(tokenInput, 'deepseek-token')
      setInput(urlInput, 'https://deepseek-proxy.example.com')
    })
    await act(async () => {
      [...rendered.container.querySelectorAll('button')]
        .find(button => button.textContent === 'Add Model')!.click()
      await Promise.resolve()
    })

    expect(rendered.addModel).toHaveBeenCalledWith(
      'DeepSeek V4 Flash',
      {
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        apiToken: 'deepseek-token',
        apiUrl: 'https://deepseek-proxy.example.com',
      },
    )
  })

  it('keeps Gateway-backed providers credential-free', async () => {
    const rendered = await render()
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>(
        '[data-select-value="other-anthropic"]')!.click()
    })
    expect(rendered.container.querySelector('[aria-label="API Token"]')).toBeNull()

    const modelInput = rendered.container.querySelector<HTMLInputElement>('[aria-label="Model ID"]')!
    const nameInput = rendered.container.querySelector<HTMLInputElement>('[aria-label="Display Name"]')!
    await act(async () => {
      setInput(modelInput, 'claude-custom')
      setInput(nameInput, 'Claude Custom')
    })
    await act(async () => {
      [...rendered.container.querySelectorAll('button')]
        .find(button => button.textContent === 'Add Model')!.click()
      await Promise.resolve()
    })

    expect(rendered.addModel).toHaveBeenCalledWith(
      'Claude Custom',
      { provider: 'anthropic', model: 'claude-custom', apiToken: '' },
    )
  })

  it('localizes the Chinese onboarding dialog without changing provider and model names', async () => {
    window.history.replaceState({}, '', '/zh')
    const rendered = await render()

    expect(rendered.container.textContent).toContain('添加 AI 模型')
    expect(rendered.container.querySelector('[aria-label="选择服务商"]')).not.toBeNull()
    expect(rendered.container.textContent).toContain('DeepSeek V4 Flash')
    expect(rendered.container.textContent).toContain('其他 Anthropic 模型…')

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>(
        '[data-select-value="other-anthropic"]')!.click()
    })
    expect(rendered.container.querySelector('[aria-label="模型 ID"]')).not.toBeNull()
    expect(rendered.container.querySelector('[aria-label="显示名称"]')).not.toBeNull()

    await act(async () => {
      [...rendered.container.querySelectorAll('button')]
        .find(button => button.textContent === '添加模型')!.click()
    })
    expect(rendered.container.textContent).toContain('请输入模型 ID')
    expect(rendered.container.textContent).toContain('请输入显示名称')
  })
})
