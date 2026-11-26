import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { ManagerScreen } from "./client/ManagerScreen";
import { LanguageSettingsScreen } from "./client/LanguageSettings";
import { hostLabels } from "./client/i18n";

function ProvidersSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Cable"
      label="Providers Manager"
      active={currentScreen?.screenId === "manager"}
      onPress={() => openScreen({ screenId: "manager" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({
    id: "manager",
    title: "Providers Manager",
    Component: ManagerScreen,
  });
  client.addSidebarHeaderItem({
    id: "providers",
    title: "Providers Manager",
    Component: ProvidersSidebarItem,
  });
  client.addCommandCenterItem({
    id: "open-providers",
    title: "Providers Manager",
    icon: "Cable",
    context: "global",
    // Keywords are matched as typed; list both languages.
    keywords: [
      "provider", "providers", "gateway", "model", "models", "catalog", "connection", "agent",
      "供应商", "提供商", "网关", "模型", "模型目录", "连接",
    ],
    onSelect({ openScreen }) {
      openScreen({ screenId: "manager" });
    },
  });
  // Settings → Plugins → Providers Manager: 跟随 Paseo / 简体中文 / English.
  client.addSettingsScreen({
    id: "language",
    title: hostLabels.message("language"),
    icon: "Languages",
    Component: LanguageSettingsScreen,
  });
  // The settings page needs the host online; this is a quick way to it.
  client.addCommandCenterItem({
    id: "providers-language",
    title: hostLabels.message("openLanguage"),
    icon: "Languages",
    context: "global",
    keywords: ["language", "语言", "中文", "English", "providers"],
    onSelect({ openSettings }) {
      openSettings("language");
    },
  });
  return () => {};
}
