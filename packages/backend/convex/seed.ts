import { internalMutation } from "./_generated/server";
import { components } from "./_generated/api";

/** One-time seed: create the default "InDemand" organization. */
export const createDefaultOrganization = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "organization",
      where: [{ field: "slug", value: "indemand" }],
    });

    if (existing) {
      console.log("Default organization already exists");
      return;
    }

    await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "organization",
        data: {
          name: "InDemand",
          slug: "indemand",
          createdAt: Date.now(),
        },
      },
    });

    console.log("Created default organization");
  },
});
