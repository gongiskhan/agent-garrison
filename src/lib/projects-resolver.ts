import {listProjectNames, readDevRoot, resolveProjectName, selfCheckoutProject} from './dev-root';

export function projectsResolver() {
  // Isolated app fixtures disable the checkout alias so every offered tree is
  // synthetic. Normal nodes include it when their checkout is outside dev-root.
  const selfCheckout = process.env.GARRISON_PROJECTS_SELF_CHECKOUT !== '0';
  return {
    devRoot: readDevRoot,
    selfCheckout: selfCheckoutProject,
    resolveProject: (project: string) => resolveProjectName(project, {selfCheckout}),
    listProjects: () => listProjectNames(readDevRoot(), {selfCheckout})
  };
}
