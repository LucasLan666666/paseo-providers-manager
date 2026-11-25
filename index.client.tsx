import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { ManagerScreen } from "./client/ManagerScreen";

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
    keywords: ["provider", "providers", "供应商", "模型", "模型目录", "agent"],
    onSelect({ openScreen }) {
      openScreen({ screenId: "manager" });
    },
  });
  return () => {};
}
