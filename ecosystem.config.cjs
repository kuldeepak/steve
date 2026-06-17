module.exports = {
  apps: [
    {
      name: "steve",
      cwd: "/home/apps.lorissaviolet.com/public_html/Steve",
      script: "npm",
      args: "run start",
      exec_mode: "fork",
      instances: 1,
      env: {
        NODE_ENV: "production",
        PORT: "4444",
        SHOPIFY_APP_URL: "https://apps.lorissaviolet.com",
        SCOPES:
          "read_files,write_files,write_metaobject_definitions,write_metaobjects,write_products,read_content,write_content",
        SHOPIFY_API_KEY: "6b442974fdb7f516c4c0f8449fedfd51",
        SHOPIFY_API_SECRET: process.env.SHOPIFY_API_SECRET,
      },
    },
  ],
};
