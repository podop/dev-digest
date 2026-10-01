/* AgentEditor — the agent's tabs: Config (model + system prompt), Skills
   (linked skills + their order) and Context (attached repo documents). Later
   lessons add Evals/Stats/CI. The tab lives in ?tab= (resolved by the route). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Tabs } from "@devdigest/ui";
import type { Agent } from "@devdigest/shared";
import { ConfigTab } from "./_components/ConfigTab";
import { ContextTab } from "./_components/ContextTab";
import { SkillsTab } from "./_components/SkillsTab";
import { TABS } from "./constants";
import { s } from "./styles";

export function AgentEditor({ agent, tab, onTab }: { agent: Agent; tab: string; onTab: (t: string) => void }) {
  const t = useTranslations("agents");
  const tabs = TABS.map((tb) => ({ key: tb.key, label: t(tb.labelKey), icon: tb.icon }));
  return (
    <div style={s.wrap}>
      <div style={s.tabsBar}>
        <Tabs tabs={tabs} value={tab} onChange={onTab} pad="0 24px" />
      </div>
      <div style={s.body}>
        {tab === "skills" && <SkillsTab key={agent.id} agent={agent} />}
        {tab === "context" && <ContextTab key={agent.id} agent={agent} />}
        {tab !== "skills" && tab !== "context" && <ConfigTab key={agent.id} agent={agent} />}
      </div>
    </div>
  );
}
