"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useWorkspace } from "@/components/workspace-provider";

const LOG_PLACEHOLDER_SECTIONS = [
  {
    title: "请求日志",
    description: "这里预留给模型请求、参数和响应状态。",
  },
  {
    title: "工具日志",
    description: "这里预留给工具调用顺序、入参和结果摘要。",
  },
  {
    title: "系统日志",
    description: "这里预留给调度、异常、重试和内部事件。",
  },
];

export function RoomLogPage({ roomId }: { roomId: string }) {
  const router = useRouter();
  const { activeRooms, getRoomById, hydrated } = useWorkspace();
  const room = getRoomById(roomId);

  useEffect(() => {
    if (!hydrated) {
      return;
    }

    if (!room) {
      const fallback = activeRooms[0];
      router.replace(fallback ? `/rooms/${fallback.id}` : "/rooms");
    }
  }, [activeRooms, hydrated, room, router]);

  if (!room) {
    return (
      <div className="page-stack">
        <section className="surface-panel empty-panel large">正在恢复日志页面...</section>
      </div>
    );
  }

  return (
    <div className="page-stack room-log-page">
      <section className="surface-panel section-panel room-log-hero page-enter">
        <div className="room-log-hero-copy">
          <p className="section-label">Log View</p>
          <h1>{room.title} 日志</h1>
          <p className="muted-copy">这里先提供二级页面 UI，后续你确定日志字段后，再把真实内容填进来。</p>
        </div>

        <div className="room-log-hero-actions">
          <Link href={`/rooms/${room.id}`} className="secondary-button">
            返回房间
          </Link>
          <button type="button" className="ghost-button" disabled>
            导出日志
          </button>
        </div>
      </section>

      <section className="surface-panel section-panel page-enter page-enter-delay-1">
        <div className="section-heading-row compact-align">
          <div>
            <p className="section-label">Overview</p>
            <h2>日志页面结构预览</h2>
          </div>
          <div className="meta-chip-row compact align-end">
            <span className="meta-chip">UI Only</span>
            <span className="meta-chip subtle">{room.roomMessages.length} 条房间消息</span>
          </div>
        </div>

        <div className="room-log-filter-row top-gap">
          <button type="button" className="tab-button active">
            全部日志
          </button>
          <button type="button" className="tab-button" disabled>
            请求
          </button>
          <button type="button" className="tab-button" disabled>
            工具
          </button>
          <button type="button" className="tab-button" disabled>
            系统
          </button>
        </div>

        <div className="trace-list top-gap">
          {LOG_PLACEHOLDER_SECTIONS.map((section, index) => (
            <article key={section.title} className="subtle-panel room-log-card">
              <div className="section-heading-row compact-align">
                <div>
                  <p className="section-label">Section {index + 1}</p>
                  <h3>{section.title}</h3>
                </div>
                <span className="meta-chip subtle">待定义</span>
              </div>

              <p className="muted-copy">{section.description}</p>

              <div className="raw-log-block room-log-placeholder top-gap">
                <pre>{`[placeholder]\n该区域仅展示 UI 结构。\n后续可替换为真实 log 列表、时间线或原始文本。\n\nroomId=${room.id}\nroomTitle=${room.title}`}</pre>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
