import { useState, FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { RpcStub } from "capnweb";
import { PublicApi } from "@gadgets/workshop-shared/api";
import { Hexagon } from "@phosphor-icons/react";
import { Input, Button, Banner } from "@cloudflare/kumo";
import { hashPassword } from "./passwordHash";
import { useServerConfig, useServerConfigError, useSiteName } from "./ServerConfigContext";
import { useDocumentTitle } from "./useDocumentTitle";
import OAuthButtons from "./components/auth/OAuthButtons";
import SiteLogo from "./components/SiteLogo";
import { useConnectionLost } from "./RpcContext";
import LanguageSelector from "./components/LanguageSelector";
import AuthConfigStatus from "./components/auth/AuthConfigStatus";
import { m as messages } from "./paraglide/messages.js";
import { extractLocaleFromUrl, localizeHref } from "./paraglide/runtime.js";

interface SignupPageProps {
  rpcStub: RpcStub<PublicApi>;
}

function continueToWorkshop() {
  const locale = extractLocaleFromUrl(new URL(window.location.href)) ?? "en";
  window.location.assign(localizeHref("/", { locale }));
}

export default function SignupPage({ rpcStub }: SignupPageProps) {
  const serverConfig = useServerConfig();
  const serverConfigError = useServerConfigError();
  const siteName = useSiteName();
  const connectionLost = useConnectionLost();
  useDocumentTitle(messages.auth_create_account_document_title());
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null);

  const usernameError =
    username && !/^[a-z][a-z0-9_]*$/i.test(username)
      ? messages.auth_username_rules()
      : undefined;

  const passwordError =
    password && password.length < 8
      ? messages.auth_password_minimum()
      : undefined;

  const confirmError =
    confirmPassword && confirmPassword !== password
      ? messages.auth_password_mismatch()
      : undefined;

  const canSubmit =
    username &&
    password &&
    confirmPassword &&
    !usernameError &&
    !passwordError &&
    !confirmError &&
    !loading;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError(null);

    try {
      const passwordHash = await hashPassword(username, password);
      const token = await rpcStub.createAccount(
        username,
        username,
        passwordHash,
      );
      if (token) {
        localStorage.setItem("authToken", token);
        continueToWorkshop();
      } else {
        setError({ title: messages.auth_username_taken() });
      }
    } catch (err) {
      setError({
        title: messages.auth_account_creation_error_title(),
        detail: err instanceof Error ? err.message : messages.auth_unknown_error_detail(),
      });
    } finally {
      setLoading(false);
    }
  };

  if (!serverConfig) {
    return <AuthConfigStatus connectionLost={connectionLost} hasError={serverConfigError} />;
  }

  const authVendors = serverConfig.authVendors ?? [];
  const signupsEnabled = serverConfig.signupsEnabled;
  // The password create-account form requires both password auth AND open signups.
  const passwordAuthEnabled = serverConfig.passwordAuthEnabled && signupsEnabled;

  return (
    <div className="min-h-screen flex items-center justify-center bg-kumo-base px-4 relative overflow-hidden">
      <LanguageSelector className="absolute right-4 top-4 z-10" />
      {/* Dot grid — fades from top to bottom */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage:
            "radial-gradient(circle, var(--color-kumo-line) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          maskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 70%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 70%)",
        }}
      />

      <div className="w-full max-w-sm relative">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <SiteLogo size={40} className="mb-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-kumo-brand mb-3">
              <Hexagon size={20} className="text-white" weight="bold" />
            </div>
          </SiteLogo>
          <h1 className="text-xl font-semibold text-kumo-default">
            {siteName}
          </h1>
          <p className="text-sm text-kumo-subtle mt-1">
            {messages.auth_create_account_heading()}
          </p>
        </div>

        {!signupsEnabled && (
          <Banner
            variant="default"
            title={messages.auth_signups_closed_title()}
            description={messages.auth_signups_closed_body()}
            className="mb-4"
          />
        )}

        {passwordAuthEnabled && (
          <>
            {/* Form */}
            <form onSubmit={handleSubmit} className="space-y-4">
              <Input
                label={messages.auth_username_label()}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                autoComplete="username"
                disabled={loading}
                placeholder={messages.auth_username_placeholder()}
                error={usernameError}
              />

              <Input
                type="password"
                label={messages.auth_password_label()}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                disabled={loading}
                placeholder={messages.auth_password_placeholder()}
                error={passwordError}
              />

              <Input
                type="password"
                label={messages.auth_confirm_password_label()}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                disabled={loading}
                placeholder={messages.auth_confirm_password_placeholder()}
                error={confirmError}
              />

              {error && (
                <Banner variant="error" title={error.title} description={error.detail} />
              )}

              <Button
                type="submit"
                variant="primary"
                disabled={!canSubmit}
                loading={loading}
                className="w-full justify-center"
              >
                {messages.auth_create_account_submit()}
              </Button>
            </form>
          </>
        )}

        {/* Gatekeeper sign-in options, shown whenever any auth vendor is configured. */}
        {authVendors.length > 0 && (
          <div className={passwordAuthEnabled ? "mt-6" : ""}>
            {passwordAuthEnabled && (
              <div className="flex items-center gap-3 mb-4">
                <div className="h-px flex-1 bg-kumo-line" />
                <span className="text-xs text-kumo-subtle">{messages.auth_or()}</span>
                <div className="h-px flex-1 bg-kumo-line" />
              </div>
            )}
            <OAuthButtons
              rpcStub={rpcStub}
              vendors={authVendors}
              onSuccess={continueToWorkshop}
            />
          </div>
        )}

        {passwordAuthEnabled && (
          <p className="text-center text-sm text-kumo-subtle mt-6">
            {messages.auth_existing_account()}{" "}
            <Link to="/" className="text-kumo-brand hover:underline font-medium">
              {messages.auth_sign_in()}
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
