import { requireUser } from "@/lib/auth/guard";
import { listProjects } from "@/lib/db/projects";
import { getDictionary } from "@/lib/i18n/server";
import { DemoNotice } from "@/components/demo/DemoNotice";
import { PageHeader } from "@/components/PageHeader";
import { ProjectsView } from "@/components/projects/ProjectsView";

export const dynamic = "force-dynamic";

export default function ProjectsPage() {
  requireUser();
  const { t } = getDictionary();
  return (
    <>
      <PageHeader title={t.projects.title} subtitle={t.projects.subtitle} />
      <DemoNotice />
      <ProjectsView projects={listProjects()} />
    </>
  );
}
