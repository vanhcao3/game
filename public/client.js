(() => {
	const socket = io();

	let myId = null;
	let mapHalfSize = 1500;
	let maxHealth = 100;

	const state = {
		players: {}, // id -> {mesh, barrel, healthBar}
		bullets: [], // {mesh}
		raw: { players: [], bullets: [] } // last snapshot
	};

	// Three.js setup
	const renderer = new THREE.WebGLRenderer({ antialias: true });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
	renderer.setSize(window.innerWidth, window.innerHeight);
	document.body.appendChild(renderer.domElement);

	const scene = new THREE.Scene();
	scene.background = new THREE.Color(0x0b0f12);

	const camera = new THREE.OrthographicCamera();
	function resizeCamera() {
		const w = window.innerWidth;
		const h = window.innerHeight;
		camera.left = -w / 2;
		camera.right = w / 2;
		camera.top = h / 2;
		camera.bottom = -h / 2;
		camera.near = -1000;
		camera.far = 1000;
		camera.position.set(0, 0, 10);
		camera.lookAt(0, 0, 0);
		camera.updateProjectionMatrix();
		renderer.setSize(w, h);
	}
	resizeCamera();
	window.addEventListener('resize', resizeCamera);

	// Ground
	const ground = new THREE.Mesh(
		new THREE.PlaneGeometry(mapHalfSize * 2, mapHalfSize * 2),
		new THREE.MeshBasicMaterial({ color: 0x11202b })
	);
	ground.position.set(0, 0, -1);
	scene.add(ground);

	// grid lines helper
	function addGrid() {
		const grid = new THREE.Group();
		const step = 200;
		const lineMat = new THREE.LineBasicMaterial({ color: 0x1c3140, transparent: true, opacity: 0.7 });
		for (let x = -mapHalfSize; x <= mapHalfSize; x += step) {
			const geom = new THREE.BufferGeometry().setFromPoints([
				new THREE.Vector3(x, -mapHalfSize, 0),
				new THREE.Vector3(x, mapHalfSize, 0)
			]);
			grid.add(new THREE.Line(geom, lineMat));
		}
		for (let y = -mapHalfSize; y <= mapHalfSize; y += step) {
			const geom = new THREE.BufferGeometry().setFromPoints([
				new THREE.Vector3(-mapHalfSize, y, 0),
				new THREE.Vector3(mapHalfSize, y, 0)
			]);
			grid.add(new THREE.Line(geom, lineMat));
		}
		grid.position.set(0, 0, -0.5);
		scene.add(grid);
	}
	addGrid();

	// Utility creators
	function createTankMesh(color) {
		const body = new THREE.Mesh(
			new THREE.PlaneGeometry(48, 48),
			new THREE.MeshBasicMaterial({ color, transparent: true })
		);
		const barrel = new THREE.Mesh(
			new THREE.PlaneGeometry(36, 10),
			new THREE.MeshBasicMaterial({ color: 0xffffff })
		);
		barrel.position.x = 24;
		const group = new THREE.Group();
		group.add(body);
		group.add(barrel);
		return { group, barrel };
	}

	function createBulletMesh() {
		return new THREE.Mesh(
			new THREE.PlaneGeometry(12, 12),
			new THREE.MeshBasicMaterial({ color: 0xffd166 })
		);
	}

	function createHealthBar() {
		const bg = new THREE.Mesh(
			new THREE.PlaneGeometry(52, 6),
			new THREE.MeshBasicMaterial({ color: 0x3a3f44 })
		);
		const fg = new THREE.Mesh(
			new THREE.PlaneGeometry(50, 4),
			new THREE.MeshBasicMaterial({ color: 0x06d6a0 })
		);
		fg.position.z = 0.01;
		const g = new THREE.Group();
		g.add(bg);
		g.add(fg);
		g.position.y = 36;
		g.position.z = 0.05;
		return { group: g, bar: fg };
	}

	// Input handling
	const inputs = { up: false, down: false, left: false, right: false, aimingAngle: 0, shooting: false };
	function setKey(e, down) {
		switch (e.code) {
			case 'KeyW': inputs.up = down; break;
			case 'KeyS': inputs.down = down; break;
			case 'KeyA': inputs.left = down; break;
			case 'KeyD': inputs.right = down; break;
			case 'Space': inputs.shooting = down; break;
		}
	}
	window.addEventListener('keydown', (e) => setKey(e, true));
	window.addEventListener('keyup', (e) => setKey(e, false));
	window.addEventListener('blur', () => { inputs.up = inputs.down = inputs.left = inputs.right = inputs.shooting = false; });

	// Mouse aiming
	let mouseX = 0, mouseY = 0;
	window.addEventListener('mousemove', (e) => {
		mouseX = e.clientX; mouseY = e.clientY;
	});
	window.addEventListener('mousedown', () => { inputs.shooting = true; });
	window.addEventListener('mouseup', () => { inputs.shooting = false; });

	function computeAimAngle() {
		const me = state.raw.players.find(p => p.id === myId);
		if (!me) return 0;
		const w = window.innerWidth;
		const h = window.innerHeight;
		const worldMouseX = mouseX - w / 2 + camera.position.x;
		const worldMouseY = (h / 2 - mouseY) + camera.position.y;
		const dx = worldMouseX - me.x;
		const dy = worldMouseY - me.y;
		return Math.atan2(dy, dx);
	}

	// Networking
	socket.on('init', (data) => {
		myId = data.id;
		mapHalfSize = data.mapHalfSize || mapHalfSize;
		maxHealth = data.maxHealth || maxHealth;
		ground.geometry.dispose();
		ground.geometry = new THREE.PlaneGeometry(mapHalfSize * 2, mapHalfSize * 2);
	});

	socket.on('state', (snapshot) => {
		state.raw = snapshot;
		updateMeshesFromState(snapshot);
		updateUI(snapshot);
	});

	function updateUI(snapshot) {
		const me = snapshot.players.find(p => p.id === myId);
		const youEl = document.getElementById('you');
		if (me && youEl) youEl.textContent = `You: ${me.score}  HP: ${me.health}`;
		const playersEl = document.getElementById('players');
		if (playersEl) playersEl.textContent = `Players: ${snapshot.players.length}`;
	}

	// Maintain meshes for players and bullets
	function updateMeshesFromState(snapshot) {
		// players
		const seen = new Set();
		for (const p of snapshot.players) {
			seen.add(p.id);
			if (!state.players[p.id]) {
				const color = p.id === myId ? 0x118ab2 : 0xef476f;
				const { group, barrel } = createTankMesh(color);
				const hp = createHealthBar();
				group.add(hp.group);
				state.players[p.id] = { mesh: group, barrel, healthBar: hp.bar };
				scene.add(group);
			}
			const ent = state.players[p.id];
			ent.mesh.position.set(p.x, p.y, 0);
			ent.mesh.rotation.z = p.angle;
			// health bar scale
			const ratio = Math.max(0, Math.min(1, p.health / maxHealth));
			ent.healthBar.scale.x = ratio;
			ent.healthBar.position.x = -25 + 25 * ratio;
		}
		for (const id in state.players) {
			if (!seen.has(id)) {
				scene.remove(state.players[id].mesh);
				delete state.players[id];
			}
		}

		// bullets (rebuild simple pool)
		const needed = snapshot.bullets.length;
		while (state.bullets.length < needed) {
			const m = createBulletMesh();
			m.position.z = 0.02;
			scene.add(m);
			state.bullets.push({ mesh: m });
		}
		while (state.bullets.length > needed) {
			const last = state.bullets.pop();
			if (last) scene.remove(last.mesh);
		}
		for (let i = 0; i < snapshot.bullets.length; i++) {
			const b = snapshot.bullets[i];
			state.bullets[i].mesh.position.set(b.x, b.y, 0.02);
		}
	}

	// Send inputs at a fixed rate
	setInterval(() => {
		inputs.aimingAngle = computeAimAngle();
		socket.emit('input', inputs);
	}, 1000 / 30);

	// Camera follows the player smoothly
	function updateCamera() {
		const me = state.raw.players.find(p => p.id === myId);
		if (!me) return;
		const lerp = 0.12;
		camera.position.x += (me.x - camera.position.x) * lerp;
		camera.position.y += (me.y - camera.position.y) * lerp;
	}

	function animate() {
		requestAnimationFrame(animate);
		updateCamera();
		renderer.render(scene, camera);
	}
	animate();
})();

