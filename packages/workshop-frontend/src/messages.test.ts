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

const requiredWorkspaceCreationMessages = [
  'composer_add_resource',
  'composer_attached_file',
  'composer_attachment_failed',
  'composer_attachment_limit',
  'composer_attachment_max_count',
  'composer_attachment_only_first_many',
  'composer_attachment_only_first_one',
  'composer_attachment_process_failed',
  'composer_attachment_too_large',
  'composer_attachment_total_too_large',
  'composer_attachment_upload_failed',
  'composer_attachment_upload_failed_detail',
  'composer_attachment_uploading',
  'composer_canvas_unavailable',
  'composer_captured_error_many',
  'composer_captured_error_one',
  'composer_captured_log_many',
  'composer_captured_log_one',
  'composer_captured_warning_many',
  'composer_captured_warning_one',
  'composer_discard_captured_logs',
  'composer_drop_files',
  'composer_hide_thinking',
  'composer_image_encode_failed',
  'composer_image_too_large',
  'composer_no_agent',
  'composer_open_chat_options',
  'composer_placeholder_follow_up',
  'composer_placeholder_new',
  'composer_placeholder_waiting',
  'composer_remove_attachment',
  'composer_remove_failed_uploads',
  'composer_select_model',
  'composer_send_captured_logs',
  'composer_send_error',
  'composer_send_message',
  'composer_show_thinking',
  'composer_slash_choose',
  'composer_slash_invalid',
  'composer_slash_load_error',
  'composer_slash_no_attachments',
  'composer_slash_ready',
  'composer_stop_agent',
  'composer_stop_error',
  'composer_start_conversation_error',
  'composer_upload_file',
  'composer_wait_for_uploads',
  'home_model_load_error',
  'home_workspace_create_error',
  'output_format_create_error',
  'output_format_creating',
  'output_format_document',
  'output_format_slides',
  'output_format_spreadsheet',
  'output_format_start_with',
  'slash_builtin_compact_description',
  'slash_commands_aria_label',
  'slash_commands_caption',
  'slash_commands_load_error',
  'slash_commands_loading',
  'slash_commands_no_match',
  'slash_commands_none',
  'slash_commands_status_found_many',
  'slash_commands_status_found_one',
  'slash_commands_status_loading',
  'slash_commands_status_unavailable',
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

  it('includes every Prompt Composer and Workspace creation message', () => {
    expect(messageKeys(english))
      .toEqual(expect.arrayContaining([...requiredWorkspaceCreationMessages]))
  })
})
