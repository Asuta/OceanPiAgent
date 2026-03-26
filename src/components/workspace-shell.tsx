"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { formatTimestamp, getRoomPreview, useWorkspace } from "@/components/workspace-provider";

function getShellTitle(pathname: string) {
  if (pathname.startsWith("/settings")) {
    return {
      title: "工作台设置",
      subtitle: "把高级配置移到独立页面，让聊天界面保持干净。",
    };
  }

  if (pathname.startsWith("/rooms/")) {
    return {
      title: "房间会话",
      subtitle: "以房间为主任务，需要时再展开执行细节。",
    };
  }

  return {
    title: "房间总览",
    subtitle: "快速浏览活跃会话、归档房间和最近状态。",
  };
}

export function WorkspaceShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { activeRooms, archivedRooms, activeRoomId, createRoom, hydrated, setActiveRoomId } = useWorkspace();

  const shellTitle = useMemo(() => getShellTitle(pathname), [pathname]);
  const sidebarRooms = useMemo(() => {
    if (!hydrated || activeRooms.length === 0) {
      return [];
    }

    const currentPathRoomId = pathname.startsWith("/rooms/") ? pathname.split("/")[2] ?? "" : activeRoomId;
    const pinned = currentPathRoomId ? activeRooms.find((room) => room.id === currentPathRoomId) : null;
    const recent = activeRooms.filter((room) => room.id !== pinned?.id).slice(0, 3);

    return pinned ? [pinned, ...recent] : activeRooms.slice(0, 4);
  }, [activeRoomId, activeRooms, hydrated, pathname]);

  return (
    <div className={`app-shell${sidebarOpen ? " sidebar-open" : ""}`}>
      <aside className="app-sidebar">
        <section className="sidebar-overview-panel surface-panel">
          <div className="sidebar-brand">
            <div>
              <p className="eyebrow-label">OceanKing</p>
              <h1>Room Workspace</h1>
            </div>
            <p className="sidebar-copy">更清晰的房间工作台：总览、聊天、设置分层展开。</p>
          </div>

          <button
            type="button"
            className="primary-button sidebar-create-button"
            onClick={() => {
              const room = createRoom();
              setSidebarOpen(false);
              router.push(`/rooms/${room.id}`);
            }}
          >
            新建房间
          </button>

          <nav className="sidebar-nav" aria-label="主导航">
            <Link href="/rooms" className={pathname === "/rooms" ? "nav-link active" : "nav-link"} onClick={() => setSidebarOpen(false)}>
              房间总览
            </Link>
            <Link
              href="/settings"
              className={pathname.startsWith("/settings") ? "nav-link active" : "nav-link"}
              onClick={() => setSidebarOpen(false)}
            >
              工作台设置
            </Link>
          </nav>
        </section>

        <section className="sidebar-section sidebar-rooms-panel surface-panel">
          <div className="section-heading-row">
            <div className="sidebar-section-heading">
              <p className="section-label">最近房间</p>
              <strong>{hydrated ? `${activeRooms.length} 个活跃会话` : "加载中"}</strong>
            </div>
            <Link href="/rooms" className="mini-button" onClick={() => setSidebarOpen(false)}>
              查看总览
            </Link>
          </div>

          <div className="sidebar-rooms-scroll">
            <div className="sidebar-room-list">
              {hydrated ? (
                sidebarRooms.map((room) => {
                  const active = pathname === `/rooms/${room.id}` || (pathname === "/rooms" && room.id === activeRoomId);
                  return (
                    <Link
                      key={room.id}
                      href={`/rooms/${room.id}`}
                      className={active ? "sidebar-room-card active" : "sidebar-room-card"}
                      onClick={() => {
                        setActiveRoomId(room.id);
                        setSidebarOpen(false);
                      }}
                    >
                      <div className="sidebar-room-topline">
                        <strong>{room.title}</strong>
                        <span>{formatTimestamp(room.updatedAt)}</span>
                      </div>
                      <p>{getRoomPreview(room)}</p>
                    </Link>
                  );
                })
              ) : (
                <div className="sidebar-empty-card">正在恢复本地房间...</div>
              )}

              {hydrated && activeRooms.length > sidebarRooms.length ? <div className="sidebar-empty-card compact-note">其余房间可在总览页继续查看。</div> : null}
            </div>

            {archivedRooms.length > 0 ? (
              <details className="sidebar-disclosure">
                <summary>归档房间 {archivedRooms.length}</summary>
                <div className="sidebar-room-list compact">
                  {archivedRooms.map((room) => (
                    <button
                      key={room.id}
                      type="button"
                      className="sidebar-room-card muted"
                      onClick={() => {
                        setActiveRoomId(room.id);
                        router.push("/rooms");
                        setSidebarOpen(false);
                      }}
                    >
                      <div className="sidebar-room-topline">
                        <strong>{room.title}</strong>
                        <span>{formatTimestamp(room.updatedAt)}</span>
                      </div>
                      <p>{getRoomPreview(room)}</p>
                    </button>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        </section>
      </aside>

      <div className="app-main-frame">
        <header className="app-topbar">
          <button type="button" className="icon-button sidebar-toggle" onClick={() => setSidebarOpen((value) => !value)}>
            {sidebarOpen ? "关闭" : "菜单"}
          </button>
          <div className="topbar-copy">
            <p className="eyebrow-label">Workspace</p>
            <h2>{shellTitle.title}</h2>
            <p>{shellTitle.subtitle}</p>
          </div>
        </header>

        <main className="workspace-view">{children}</main>
      </div>

      <button type="button" aria-label="关闭侧边栏" className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />
    </div>
  );
}
