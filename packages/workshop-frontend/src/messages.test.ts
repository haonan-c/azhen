import { describe, expect, it } from 'vitest'
import english from '../messages/en.json'
import chinese from '../messages/zh.json'

const messageKeys = (catalog: Record<string, string>) =>
  Object.keys(catalog).filter(key => key !== '$schema').sort()

const requiredAuthMessages = [
  'auth_account_creation_error_title',
  'auth_cancelled',
  'auth_confirm_password_label',
  'auth_confirm_password_placeholder',
  'auth_continue_with_provider',
  'auth_create_account',
  'auth_create_account_document_title',
  'auth_create_account_heading',
  'auth_create_account_submit',
  'auth_deployment_settings_error',
  'auth_existing_account',
  'auth_invalid_credentials',
  'auth_loading',
  'auth_no_account',
  'auth_or',
  'auth_password_label',
  'auth_password_minimum',
  'auth_password_mismatch',
  'auth_password_placeholder',
  'auth_popup_blocked',
  'auth_reload',
  'auth_server_retrying',
  'auth_sign_in',
  'auth_sign_in_document_title',
  'auth_sign_in_error_title',
  'auth_sign_in_heading',
  'auth_sign_in_submit',
  'auth_signups_closed_body',
  'auth_signups_closed_title',
  'auth_unknown_error_detail',
  'auth_username_label',
  'auth_username_placeholder',
  'auth_username_rules',
  'auth_username_taken',
  'language_chinese',
  'language_english',
  'language_label',
  'user_menu_admin',
  'user_menu_language',
  'user_menu_open',
  'user_menu_profile',
  'user_menu_providers',
  'user_menu_sign_out',
] as const

describe('message catalogs', () => {
  it('defines the same non-empty messages in English and Simplified Chinese', () => {
    expect(messageKeys(chinese)).toEqual(messageKeys(english))
    for (const key of messageKeys(english)) {
      expect(english[key as keyof typeof english]).not.toBe('')
      expect(chinese[key as keyof typeof chinese]).not.toBe('')
    }
  })

  it('includes every authentication and global language-control message', () => {
    expect(messageKeys(english)).toEqual(expect.arrayContaining([...requiredAuthMessages]))
  })
})
