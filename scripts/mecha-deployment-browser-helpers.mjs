/** Use the actual local deployment UI, never flip phase or disable deployment. */
export async function completeLocalDeployment(page, preferred = []) {
  // Some inspection regressions explicitly inject an already-started combat
  // fixture. Keep that scope; product-created matches must use deployment UI.
  const phase = await page.locator(".mecha-overlay[data-phase]").getAttribute("data-phase");
  if (phase !== "deployment") return [];
  const confirm = page.getByRole("button", { name: /^(确认部署|Confirm deployment)$/ });
  await confirm.waitFor({ state: "visible", timeout: 60000 });
  const used = new Set();
  const list = page.locator(".mecha-deploy-list");
  if (await list.getAttribute("open") === null) await list.locator("summary").click();
  for (let i = 0; i < 3; i++) {
    await page.locator(".mecha-deploy-roster .mecha-plan-card__select").nth(i).click();
    const values = await page.locator("#mecha-deploy-choice option").evaluateAll(rows => rows.map(r => r.value).filter(Boolean));
    const at = preferred[i];
    const wanted = typeof at === "string" ? at : at ? `${at.x},${at.y}` : null;
    const cell = wanted && values.includes(wanted) && !used.has(wanted) ? wanted : values.find(v => !used.has(v));
    if (!cell) throw Error("Fixture has fewer than three safe deployment cells");
    used.add(cell);
    await page.locator("#mecha-deploy-choice").selectOption(cell);
    await page.getByRole("button", { name: /^(放置机甲|Place mech)$/ }).click();
  }
  await confirm.click();
  await page.locator('[data-phase="player_plan"]').waitFor();
  return [...used];
}
