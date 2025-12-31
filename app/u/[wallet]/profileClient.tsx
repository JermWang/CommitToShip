"use client";

import { useEffect, useMemo, useState } from "react";
import bs58 from "bs58";

type Profile = {
  walletPubkey: string;
  displayName?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  avatarPath?: string | null;
  createdAtUnix: number;
  updatedAtUnix: number;
};

async function readJsonSafe(res: Response): Promise<any> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (!text.trim().length) return {};
  if (contentType.toLowerCase().includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return { error: text };
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

async function jsonPost(path: string, body: unknown): Promise<any> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body ?? {}),
  });
  const json = await readJsonSafe(res);
  if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
  return json;
}

function shortWallet(pk: string): string {
  const s = String(pk ?? "");
  if (s.length <= 10) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function expectedProfileUpdateMessage(input: { walletPubkey: string; timestampUnix: number; payloadJson: string }): string {
  return `Commit To Ship\nProfile Update\nWallet: ${input.walletPubkey}\nTimestamp: ${input.timestampUnix}\nPayload: ${input.payloadJson}`;
}

function expectedAvatarUploadMessage(input: { walletPubkey: string; timestampUnix: number; contentType: string }): string {
  return `Commit To Ship\nAvatar Upload\nWallet: ${input.walletPubkey}\nTimestamp: ${input.timestampUnix}\nContentType: ${input.contentType}`;
}

export default function ProfileClient({ wallet }: { wallet: string }) {
  const walletParam = String(wallet ?? "").trim();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [connectedWallet, setConnectedWallet] = useState<string | null>(null);

  const targetWallet = String(profile?.walletPubkey ?? walletParam);
  const canEdit = useMemo(() => Boolean(connectedWallet) && connectedWallet === targetWallet, [connectedWallet, targetWallet]);

  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");

  function getSolanaProvider(): any {
    return (window as any)?.solana;
  }

  async function load() {
    const res = await fetch(`/api/profiles/${encodeURIComponent(walletParam)}`, { cache: "no-store" });
    const json = await readJsonSafe(res);
    if (!res.ok) throw new Error(json?.error ?? `Request failed (${res.status})`);
    setProfile(json?.profile ?? null);
  }

  useEffect(() => {
    setError(null);
    load().catch((e) => setError((e as Error).message));
  }, [walletParam]);

  useEffect(() => {
    if (!profile) return;
    setDisplayName(String(profile.displayName ?? ""));
    setBio(String(profile.bio ?? ""));
  }, [profile?.walletPubkey]);

  async function connectWallet() {
    setError(null);
    setBusy("connect");
    try {
      const provider = getSolanaProvider();
      if (!provider?.connect) throw new Error("Wallet provider not found");
      const res = await provider.connect();
      const pk = (res?.publicKey ?? provider.publicKey)?.toBase58?.();
      if (!pk) throw new Error("Failed to read wallet public key");
      setConnectedWallet(pk);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function saveProfile() {
    setError(null);
    setBusy("save");
    try {
      const provider = getSolanaProvider();
      if (!provider?.publicKey) throw new Error("Connect wallet first");
      if (!provider.signMessage) throw new Error("Wallet does not support message signing");

      const walletPubkey = provider.publicKey.toBase58();
      if (walletPubkey !== targetWallet) throw new Error("Connected wallet must match this profile");

      const payload = {
        displayName: displayName.trim().length ? displayName.trim() : null,
        bio: bio.trim().length ? bio : null,
        avatarUrl: profile?.avatarUrl ?? null,
        avatarPath: profile?.avatarPath ?? null,
      };
      const payloadJson = JSON.stringify(payload);

      const timestampUnix = Math.floor(Date.now() / 1000);
      const message = expectedProfileUpdateMessage({ walletPubkey, timestampUnix, payloadJson });
      const signed = await provider.signMessage(new TextEncoder().encode(message), "utf8");
      const signatureBytes: Uint8Array = signed?.signature ?? signed;
      const signatureB58 = bs58.encode(signatureBytes);

      const res = await jsonPost(`/api/profiles/${encodeURIComponent(walletPubkey)}`, {
        walletPubkey,
        ...payload,
        timestampUnix,
        signatureB58,
      });

      setProfile(res?.profile ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function uploadAvatar(file: File) {
    setError(null);
    setBusy("upload");
    try {
      const provider = getSolanaProvider();
      if (!provider?.publicKey) throw new Error("Connect wallet first");
      if (!provider.signMessage) throw new Error("Wallet does not support message signing");

      const walletPubkey = provider.publicKey.toBase58();
      if (walletPubkey !== targetWallet) throw new Error("Connected wallet must match this profile");

      const timestampUnix = Math.floor(Date.now() / 1000);
      const message = expectedAvatarUploadMessage({ walletPubkey, timestampUnix, contentType: file.type || "image/png" });
      const signed = await provider.signMessage(new TextEncoder().encode(message), "utf8");
      const signatureBytes: Uint8Array = signed?.signature ?? signed;
      const signatureB58 = bs58.encode(signatureBytes);

      const info = await jsonPost("/api/profiles/avatar/upload-url", {
        walletPubkey,
        timestampUnix,
        signatureB58,
        contentType: file.type || "image/png",
      });

      const signedUrl = String(info?.signedUrl ?? "");
      if (!signedUrl) throw new Error("Missing signedUrl");

      const form = new FormData();
      form.append("cacheControl", "3600");
      form.append("", file);

      const uploadRes = await fetch(signedUrl, {
        method: "PUT",
        headers: {
          "x-upsert": "true",
        },
        body: form,
      });

      if (!uploadRes.ok) {
        const text = await uploadRes.text().catch(() => "");
        throw new Error(`Upload failed (${uploadRes.status}) ${text}`);
      }

      const avatarUrl = String(info?.publicUrl ?? "");
      const avatarPath = String(info?.path ?? "");
      if (!avatarUrl) throw new Error("Missing publicUrl");

      setProfile((prev) =>
        prev
          ? { ...prev, avatarUrl, avatarPath }
          : {
              walletPubkey: targetWallet,
              displayName: null,
              bio: null,
              avatarUrl,
              avatarPath,
              createdAtUnix: 0,
              updatedAtUnix: 0,
            }
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stage">
      <div className="panel" style={{ width: "100%" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>Profile</div>
            <div style={{ fontSize: 18, fontWeight: 800 }}>{profile?.displayName?.trim() || shortWallet(profile?.walletPubkey || walletParam)}</div>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn" onClick={connectWallet} disabled={busy != null}>
              {busy === "connect" ? "Connecting…" : connectedWallet ? "Wallet Connected" : "Connect Wallet"}
            </button>
          </div>
        </div>

        {error ? <div style={{ marginTop: 14, color: "rgba(180, 40, 60, 0.86)" }}>{error}</div> : null}

        <div style={{ display: "flex", gap: 18, marginTop: 18, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ width: 120, height: 120, borderRadius: 18, overflow: "hidden", border: "1px solid rgba(255,255,255,0.16)", background: "rgba(255,255,255,0.06)" }}>
            {profile?.avatarUrl ? (
              <img src={profile.avatarUrl} alt="avatar" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, opacity: 0.8 }}>
                {shortWallet(profile?.walletPubkey || walletParam)}
              </div>
            )}
          </div>

          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ fontSize: 12, opacity: 0.7 }}>Wallet</div>
            <div className="mono" style={{ marginTop: 4 }}>{profile?.walletPubkey || walletParam}</div>

            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, opacity: 0.7 }}>Display name</div>
              <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} disabled={!canEdit || busy != null} style={{ width: "100%", marginTop: 6 }} />
            </div>

            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, opacity: 0.7 }}>Bio</div>
              <textarea className="input" value={bio} onChange={(e) => setBio(e.target.value)} disabled={!canEdit || busy != null} style={{ width: "100%", marginTop: 6, minHeight: 92 }} />
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
              <button className="btn btnPrimary" onClick={saveProfile} disabled={!canEdit || busy != null}>
                {busy === "save" ? "Saving…" : "Save"}
              </button>
              <label className="btn" style={{ display: "inline-flex", alignItems: "center", gap: 10, cursor: canEdit && busy == null ? "pointer" : "not-allowed", opacity: canEdit ? 1 : 0.6 }}>
                {busy === "upload" ? "Uploading…" : "Upload avatar"}
                <input
                  type="file"
                  accept="image/*"
                  disabled={!canEdit || busy != null}
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) uploadAvatar(f);
                    e.currentTarget.value = "";
                  }}
                />
              </label>
            </div>

            {!canEdit ? (
              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
                Connect the matching wallet to edit this profile.
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
