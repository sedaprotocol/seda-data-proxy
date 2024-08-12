Bun.serve({
	async fetch(req: Request): Promise<Response> {
		console.log("[DEBUG]: req ::: ", req);
		const text = await req.text();
		return new Response(`{"aaa": "${req.url}"}`);
	},

	// Optional port number - the default value is 3000
	port: process.env.PORT || 3000,
});
