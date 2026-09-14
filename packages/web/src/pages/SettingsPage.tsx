import { useEffect, useRef, useState } from "react";
import type { AccessPolicy } from "@peer-cast/shared";
import { useNavigate } from "react-router-dom";
import { Avatar } from "../components/Avatar";
import { Spinner } from "../components/Spinner";
import { Modal } from "../components/Modal";
import {
  useChangeEmailMutation,
  useChangePasswordMutation,
  useDeleteAccountMutation,
  useGetMeQuery,
  useGetVapidKeyQuery,
  useSubscribePushMutation,
  useUnsubscribePushMutation,
  useUpdateProfileMutation,
  useUpdateSettingsMutation,
} from "../store/api";
import {
  destroyPushSubscription,
  ensurePushSubscription,
  getPushSubscription,
  pushSupported,
  subscriptionToData,
} from "../lib/push";
import { useAppDispatch } from "../store";
import { loggedOut, userUpdated } from "../store/authSlice";
import { addToast, errorMessage } from "../store/toastSlice";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card p-6">
      <h2 className="mb-4 text-lg font-bold">{title}</h2>
      {children}
    </div>
  );
}

export function SettingsPage() {
  const { data: me, isLoading } = useGetMeQuery();
  const [updateProfile, profileState] = useUpdateProfileMutation();
  const [updateSettings, settingsState] = useUpdateSettingsMutation();
  const [changePassword, passwordState] = useChangePasswordMutation();
  const [changeEmail, emailState] = useChangeEmailMutation();
  const { data: vapid } = useGetVapidKeyQuery();
  const [subscribePush] = useSubscribePushMutation();
  const [unsubscribePush] = useUnsubscribePushMutation();
  const [notifOn, setNotifOn] = useState(false);
  const [notifBusy, setNotifBusy] = useState(false);
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const [deleteAccount, deleteState] = useDeleteAccountMutation();
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const [displayName, setDisplayName] = useState("");
  const [about, setAbout] = useState("");
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | null>(null);
  const [settings, setSettings] = useState({
    defaultAccess: "public" as AccessPolicy,
    defaultTitle: "Live broadcast",
    discoverable: true,
  });
  const [pw, setPw] = useState({ current: "", next: "" });
  const [newEmail, setNewEmail] = useState("");

  useEffect(() => {
    if (me) {
      setDisplayName(me.user.displayName);
      setAbout(me.user.about ?? "");
      setAvatarDataUrl(me.user.avatarUrl ?? null);
      setSettings(me.settings);
    }
  }, [me]);

  if (isLoading || !me) return <Spinner label="Loading settings…" />;

  function onAvatarPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setAvatarDataUrl(reader.result as string);
    reader.readAsDataURL(file);
  }

  async function saveProfile() {
    try {
      const res = await updateProfile({
        displayName,
        about: about || null,
        avatarDataUrl: avatarDataUrl ?? undefined,
      }).unwrap();
      dispatch(userUpdated(res.user));
      dispatch(addToast("Profile saved.", "success"));
    } catch (err) {
      dispatch(addToast(errorMessage(err, "Save failed"), "error"));
    }
  }

  async function saveSettings() {
    try {
      await updateSettings(settings).unwrap();
      dispatch(addToast("Settings saved.", "success"));
    } catch (err) {
      dispatch(addToast(errorMessage(err, "Could not save settings"), "error"));
    }
  }

  async function savePassword() {
    try {
      await changePassword({
        currentPassword: pw.current,
        newPassword: pw.next,
      }).unwrap();
      setPw({ current: "", next: "" });
      dispatch(addToast("Password changed.", "success"));
    } catch (err) {
      dispatch(
        addToast(errorMessage(err, "Could not change password"), "error"),
      );
    }
  }

  async function saveEmail() {
    try {
      await changeEmail({ newEmail }).unwrap();
      setNewEmail("");
      dispatch(
        addToast(
          "We sent a confirmation link to your new email address.",
          "success",
        ),
      );
    } catch (err) {
      dispatch(addToast(errorMessage(err, "Could not change email"), "error"));
    }
  }

  // Reflect the device's actual push subscription state once the user visits
  // this page (VAPID availability gates the whole section).
  useEffect(() => {
    let alive = true;
    void getPushSubscription().then((sub) => {
      if (alive) setNotifOn(!!sub);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function toggleNotifications() {
    if (!vapid || notifBusy) return;
    setNotifBusy(true);
    try {
      if (notifOn) {
        const before = await getPushSubscription();
        await destroyPushSubscription();
        if (before) {
          await unsubscribePush({
            endpoint: before.endpoint,
          }).unwrap();
        }
        setNotifOn(false);
        dispatch(addToast("Notifications disabled.", "success"));
      } else {
        const sub = await ensurePushSubscription(vapid.publicKey);
        if (!sub) {
          dispatch(
            addToast(
              "Notification permission was not granted in this browser.",
              "warning",
            ),
          );
          return;
        }
        await subscribePush({ subscription: subscriptionToData(sub) }).unwrap();
        setNotifOn(true);
        dispatch(addToast("Notifications enabled.", "success"));
      }
    } catch (err) {
      dispatch(
        addToast(
          errorMessage(err, "Could not change notification settings"),
          "error",
        ),
      );
    } finally {
      setNotifBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      <Section title="Profile">
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <Avatar
              user={{ displayName, avatarUrl: avatarDataUrl }}
              size={72}
            />
            <div>
              <button
                className="btn-ghost"
                onClick={() => fileRef.current?.click()}
              >
                Change avatar
              </button>
              {avatarDataUrl && (
                <button
                  className="btn-ghost ml-2"
                  onClick={() => setAvatarDataUrl(null)}
                >
                  Remove
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={onAvatarPick}
              />
            </div>
          </div>
          <div>
            <label className="label">Display name</label>
            <input
              className="input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div>
            <label className="label">About</label>
            <textarea
              className="input"
              rows={3}
              value={about}
              onChange={(e) => setAbout(e.target.value)}
            />
          </div>
          <button
            className="btn-primary"
            onClick={saveProfile}
            disabled={profileState.isLoading}
          >
            Save profile
          </button>
        </div>
      </Section>

      <Section title="Broadcast defaults">
        <div className="space-y-4">
          <div>
            <label className="label">Default title</label>
            <input
              className="input"
              value={settings.defaultTitle}
              onChange={(e) =>
                setSettings((s) => ({ ...s, defaultTitle: e.target.value }))
              }
            />
          </div>
          <div>
            <label className="label">Default access</label>
            <select
              className="input"
              value={settings.defaultAccess}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  defaultAccess: e.target.value as AccessPolicy,
                }))
              }
            >
              <option value="public">Public</option>
              <option value="authenticated">Members</option>
              <option value="code">Code</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.discoverable}
              onChange={(e) =>
                setSettings((s) => ({ ...s, discoverable: e.target.checked }))
              }
            />
            Appear in the public directory and live listings
          </label>
          <button
            className="btn-primary"
            onClick={saveSettings}
            disabled={settingsState.isLoading}
          >
            Save settings
          </button>
        </div>
      </Section>

      <Section title="Change email">
        <p className="mb-4 text-sm text-slate-400">
          Current address: <strong>{me.user.email}</strong>
          {me.user.emailVerified ? "" : " (unverified)"}
        </p>
        <div className="space-y-4">
          <div>
            <label className="label">New email address</label>
            <input
              className="input"
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </div>
          <p className="text-sm text-slate-400">
            A confirmation link will be sent to the new address. Your email only
            changes after you click it.
          </p>
          <button
            className="btn-primary"
            onClick={saveEmail}
            disabled={emailState.isLoading || !newEmail.includes("@")}
          >
            {emailState.isLoading ? "Sending…" : "Send confirmation"}
          </button>
        </div>
      </Section>

      <Section title="Notifications">
        {!pushSupported() ? (
          <p className="text-sm text-slate-400">
            Your browser doesn't support push notifications (or this page isn't
            served over HTTPS).
          </p>
        ) : !vapid ? (
          <p className="text-sm text-slate-400">
            Push notifications are disabled on this server — the admin hasn't
            configured VAPID keys. Followed-user alerts will not be sent.
          </p>
        ) : (
          <div className="flex items-start justify-between gap-4">
            <div className="text-sm text-slate-300">
              <p>
                Get a browser notification when someone you follow goes live.
              </p>
              <p className="mt-1 text-slate-500">
                Manage your follows from any /watch page with the Follow button.
              </p>
            </div>
            <button
              className={
                notifOn ? "btn-ghost shrink-0" : "btn-primary shrink-0"
              }
              onClick={() => void toggleNotifications()}
              disabled={notifBusy}
            >
              {notifBusy
                ? "…"
                : notifOn
                  ? "Disable notifications"
                  : "Enable notifications"}
            </button>
          </div>
        )}
      </Section>

      <Section title="Change password">
        <div className="space-y-4">
          <div>
            <label className="label">Current password</label>
            <input
              className="input"
              type="password"
              value={pw.current}
              onChange={(e) =>
                setPw((p) => ({ ...p, current: e.target.value }))
              }
              autoComplete="current-password"
            />
          </div>
          <div>
            <label className="label">New password</label>
            <input
              className="input"
              type="password"
              value={pw.next}
              onChange={(e) => setPw((p) => ({ ...p, next: e.target.value }))}
              autoComplete="new-password"
            />
          </div>
          <button
            className="btn-primary"
            onClick={savePassword}
            disabled={
              passwordState.isLoading || !pw.current || pw.next.length < 8
            }
          >
            Change password
          </button>
        </div>
      </Section>

      {/* ─── Danger zone ────────────────────────────────────────────────── */}
      <Section title="Danger zone">
        <p className="text-sm text-slate-400">
          Permanently delete your account and all associated data. This cannot
          be undone.
        </p>
        <button
          className="btn-danger mt-3"
          onClick={() => setShowDeleteModal(true)}
        >
          Delete account
        </button>
      </Section>

      <Modal
        open={showDeleteModal}
        title="Delete account"
        onClose={() => {
          setShowDeleteModal(false);
          setDeletePassword("");
        }}
        actions={
          <>
            <button
              className="btn-ghost"
              onClick={() => {
                setShowDeleteModal(false);
                setDeletePassword("");
              }}
            >
              Cancel
            </button>
            <button
              className="btn-danger"
              disabled={deleteState.isLoading || !deletePassword}
              onClick={async () => {
                try {
                  await deleteAccount({ password: deletePassword }).unwrap();
                  dispatch(loggedOut());
                  navigate("/");
                  dispatch(
                    addToast(
                      "Your account has been permanently deleted.",
                      "success",
                    ),
                  );
                } catch (err) {
                  dispatch(
                    addToast(
                      errorMessage(err, "Account deletion failed"),
                      "error",
                    ),
                  );
                }
              }}
            >
              {deleteState.isLoading ? "Deleting…" : "Delete permanently"}
            </button>
          </>
        }
      >
        <p className="text-sm text-slate-300">
          This will permanently delete your account, all broadcasts, and all
          associated data. You cannot undo this.
        </p>
        <label className="label mt-4">Confirm your password</label>
        <input
          className="input"
          type="password"
          autoFocus
          value={deletePassword}
          onChange={(e) => setDeletePassword(e.target.value)}
          placeholder="Your current password"
        />
      </Modal>
    </div>
  );
}
