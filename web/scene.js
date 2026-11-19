import * as THREE from 'three';
import { OrbitControls } from '/vendor/OrbitControls.js';

const COLORS = { gateway: 0x63ff9e, self: 0xd9ff80, device: 0x47c977 };
const TAU = Math.PI * 2;

function getSatellitePosition(index, count) {
  const rings = [
    { radius: 6.2, capacity: 12 },
    { radius: 8.6, capacity: 18 },
    { radius: 11, capacity: 24 }
  ];
  const layerCapacity = rings.reduce((sum, ring) => sum + ring.capacity, 0);
  const layer = Math.floor(index / layerCapacity);
  const layerCount = Math.max(1, Math.ceil(count / layerCapacity));
  let withinLayer = index % layerCapacity;
  let ringStart = layer * layerCapacity;
  let ringIndex = 0;
  while (withinLayer >= rings[ringIndex].capacity) {
    withinLayer -= rings[ringIndex].capacity;
    ringStart += rings[ringIndex].capacity;
    ringIndex++;
  }
  const ring = rings[ringIndex];
  const nodesInRing = Math.min(ring.capacity, count - ringStart);
  const angle = (withinLayer / Math.max(nodesInRing, 1)) * TAU + 0.45 + ringIndex * 0.38 + layer * 0.31;
  const layerSpacing = layerCount > 1 ? Math.min(1.25, 5 / (layerCount - 1)) : 0;
  return {
    x: Math.cos(angle) * ring.radius,
    y: 0.85 + layer * layerSpacing + (withinLayer % 3) * 0.12,
    z: Math.sin(angle) * ring.radius
  };
}

// All positions here are an abstract layout, never measured device locations.
export function createNetworkScene({ container, labels, onSelect = () => {} }) {
  if (!container || !labels) throw new Error('缺少空间视图容器');

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setClearColor(0x050907, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.setAttribute('aria-label', '模拟网络关系空间；可拖动旋转、滚轮缩放，或在设备列表中选择设备');
  renderer.domElement.setAttribute('role', 'img');
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x050907, 0.026);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 110);
  const home = new THREE.Vector3(12.5, 10.5, 15.5);
  camera.position.copy(home);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.8, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.065;
  controls.enablePan = false;
  controls.minDistance = 9;
  controls.maxDistance = 37;
  controls.minPolarAngle = 0.2;
  controls.maxPolarAngle = Math.PI / 2.16;
  controls.autoRotate = !reducedMotion.matches;
  controls.autoRotateSpeed = 0.28;
  controls.update();

  const atmosphere = new THREE.Group();
  const nodeGroup = new THREE.Group();
  const linkGroup = new THREE.Group();
  scene.add(atmosphere, linkGroup, nodeGroup);

  const grid = new THREE.GridHelper(66, 44, 0x23683b, 0x123321);
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  atmosphere.add(grid);

  function lineRing(radius, color, opacity = 0.3, y = 0.018, segments = 128) {
    const points = [];
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * TAU;
      points.push(new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius));
    }
    return new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
    );
  }

  [3.3, 6.2, 9.5, 13.2].forEach((radius, i) => {
    atmosphere.add(lineRing(radius, 0x287344, 0.23 - i * 0.025));
  });

  // Short ticks give the floor a calibrated visual rhythm without implying distance.
  const tickPoints = [];
  for (let i = 0; i < 64; i++) {
    const angle = i / 64 * TAU;
    const radius = 9.5;
    const length = i % 8 === 0 ? 0.4 : 0.17;
    tickPoints.push(new THREE.Vector3(Math.cos(angle) * radius, 0.025, Math.sin(angle) * radius));
    tickPoints.push(new THREE.Vector3(Math.cos(angle) * (radius + length), 0.025, Math.sin(angle) * (radius + length)));
  }
  atmosphere.add(new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(tickPoints),
    new THREE.LineBasicMaterial({ color: 0x55a96a, transparent: true, opacity: 0.3 })
  ));

  const starPositions = new Float32Array(105 * 3);
  let seed = 41;
  const random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  for (let i = 0; i < 105; i++) {
    starPositions[i * 3] = (random() - 0.5) * 68;
    starPositions[i * 3 + 1] = random() * 20 + 1;
    starPositions[i * 3 + 2] = (random() - 0.5) * 60;
  }
  const starsGeometry = new THREE.BufferGeometry();
  starsGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
  atmosphere.add(new THREE.Points(starsGeometry, new THREE.PointsMaterial({ color: 0x75d88f, size: 0.035, transparent: true, opacity: 0.4, depthWrite: false })));

  const glowCanvas = document.createElement('canvas');
  glowCanvas.width = glowCanvas.height = 128;
  const ctx = glowCanvas.getContext('2d');
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(255,255,255,.55)');
  gradient.addColorStop(0.2, 'rgba(255,255,255,.15)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  const glowTexture = new THREE.CanvasTexture(glowCanvas);

  let records = new Map();
  let pickTargets = [];
  let selectedId = null;
  let filterIds = null;
  let destroyed = false;
  let width = 1;
  let height = 1;
  let pointerStart = null;
  let lastTime = 0;
  const pointer = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const projection = new THREE.Vector3();
  const clock = new THREE.Clock();

  function disposeGroup(group) {
    const geometries = new Set();
    const materials = new Set();
    group.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);
      if (object.material) {
        (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => materials.add(material));
      }
    });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
    group.clear();
  }

  function addNode(device, position, index) {
    const kind = device.kind in COLORS ? device.kind : 'device';
    const color = COLORS[kind];
    const group = new THREE.Group();
    group.position.copy(position);
    const radius = kind === 'gateway' ? 0.88 : kind === 'self' ? 0.42 : 0.29;
    const coreMaterial = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: kind === 'gateway' ? 0.25 : 0.8, depthWrite: false });
    const core = new THREE.Mesh(
      kind === 'self' ? new THREE.BoxGeometry(radius * 1.5, radius * 1.5, radius * 1.5) : new THREE.IcosahedronGeometry(radius, kind === 'gateway' ? 1 : 2),
      coreMaterial
    );
    group.add(core);

    const edgeGeometry = new THREE.EdgesGeometry(core.geometry);
    const edges = new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: kind === 'gateway' ? 0.82 : 0.35 }));
    group.add(edges);

    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, color, transparent: true, opacity: kind === 'gateway' ? 0.8 : 0.48, depthWrite: false, blending: THREE.AdditiveBlending }));
    const glowSize = kind === 'gateway' ? 6.6 : kind === 'self' ? 2.8 : 1.8;
    glow.scale.set(glowSize, glowSize, 1);
    group.add(glow);

    const band = lineRing(radius * 1.58, color, kind === 'gateway' ? 0.65 : 0.5, 0);
    band.rotation.x = kind === 'gateway' ? 0.32 : 0.08;
    group.add(band);
    if (kind === 'gateway') {
      const innerBand = lineRing(radius * 1.24, color, 0.32, 0);
      innerBand.rotation.z = 1.1;
      innerBand.rotation.x = 0.8;
      group.add(innerBand);
      const spindle = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -1.2, 0), new THREE.Vector3(0, 1.5, 0)]),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.3 })
      );
      group.add(spindle);
    }

    const halo = lineRing(kind === 'gateway' ? 1.5 : 0.68, color, 0.18, 0.04 - position.y, 64);
    group.add(halo);
    const stem = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -position.y, 0), new THREE.Vector3(0, -radius, 0)]),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.2 })
    );
    group.add(stem);
    const selection = lineRing(radius * 2.1, color, 0.9, 0);
    selection.rotation.x = Math.PI / 2;
    selection.visible = false;
    group.add(selection);

    const hitMesh = new THREE.Mesh(new THREE.SphereGeometry(Math.max(radius * 1.5, 0.6), 10, 8), new THREE.MeshBasicMaterial({ visible: false }));
    hitMesh.userData.deviceId = String(device.id);
    group.add(hitMesh);
    pickTargets.push(hitMesh);

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'scene-node-label';
    label.dataset.kind = kind;
    label.dataset.deviceId = String(device.id);
    label.style.position = 'absolute';
    label.style.left = '0';
    label.style.top = '0';
    label.style.pointerEvents = 'auto';
    label.setAttribute('aria-label', `${kind === 'gateway' ? '网关' : kind === 'self' ? '本机' : '设备'} ${device.displayName || device.hostname || device.ip}，${device.ip}`);
    const labelName = document.createElement('span');
    labelName.className = 'node-label-name';
    labelName.textContent = device.displayName || (kind === 'gateway' ? '网络网关' : kind === 'self' ? '本机' : device.hostname || '局域网设备');
    const labelIp = document.createElement('span');
    labelIp.className = 'node-label-ip';
    labelIp.textContent = device.ip || String(device.id);
    label.append(labelName, labelIp);
    label.addEventListener('click', () => onSelect(device.id));
    labels.appendChild(label);
    nodeGroup.add(group);
    records.set(String(device.id), { device, group, core, glow, band, selection, label, radius, phase: index * 1.62, baseY: position.y });
  }

  function setDevices(devices = [], links = []) {
    disposeGroup(nodeGroup);
    disposeGroup(linkGroup);
    labels.replaceChildren();
    records = new Map();
    pickTargets = [];
    const ordered = [...devices].sort((a, b) => {
      const rank = { gateway: 0, self: 1, device: 2 };
      return (rank[a.kind] ?? 2) - (rank[b.kind] ?? 2) || String(a.ip).localeCompare(String(b.ip), undefined, { numeric: true });
    });
    const satelliteCount = ordered.filter(device => device.kind !== 'gateway' && device.kind !== 'self').length;
    let satelliteIndex = 0;
    let gatewayIndex = 0;
    for (let index = 0; index < ordered.length; index++) {
      const device = ordered[index];
      let position;
      if (device.kind === 'gateway') {
        position = new THREE.Vector3(gatewayIndex * 3, 1.45, 0);
        gatewayIndex++;
      } else if (device.kind === 'self') {
        position = new THREE.Vector3(-4.3, 1.05, 3.8);
      } else {
        const coordinates = getSatellitePosition(satelliteIndex, satelliteCount);
        position = new THREE.Vector3(coordinates.x, coordinates.y, coordinates.z);
        satelliteIndex++;
      }
      addNode(device, position, index);
    }
    const fallbackGateway = ordered.find(device => device.kind === 'gateway') || ordered.find(device => device.kind === 'self');
    const knownLinks = links.length ? links : fallbackGateway ? ordered.filter(device => device.id !== fallbackGateway.id).map(device => ({ source: fallbackGateway.id, target: device.id })) : [];
    for (const link of knownLinks) {
      const source = records.get(String(link.source));
      const target = records.get(String(link.target));
      if (!source || !target) continue;
      const start = source.group.position.clone();
      const end = target.group.position.clone();
      const midpoint = start.clone().lerp(end, 0.5);
      midpoint.y += Math.min(start.distanceTo(end) * 0.12, 1.1);
      const curve = new THREE.QuadraticBezierCurve3(start, midpoint, end);
      const material = new THREE.LineDashedMaterial({ color: 0x318c50, transparent: true, opacity: 0.48, dashSize: 0.12, gapSize: 0.1, depthWrite: false });
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(55)), material);
      line.computeLineDistances();
      line.userData.source = String(link.source);
      line.userData.target = String(link.target);
      linkGroup.add(line);
    }
    setSelected(selectedId);
    applyFilter();
    frameScene();
  }

  function frameScene() {
    if (!records.size) {
      camera.position.copy(home);
      controls.target.set(0, 0.8, 0);
      controls.maxDistance = 37;
      scene.fog.density = 0.026;
    } else {
      const bounds = new THREE.Sphere().setFromPoints([...records.values()].map(record => record.group.position));
      const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov / 2);
      const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * camera.aspect);
      const limitingHalfFov = Math.min(verticalHalfFov, horizontalHalfFov);
      const distance = Math.max(15, (bounds.radius + 1.6) / Math.sin(limitingHalfFov) * 1.08);
      controls.target.copy(bounds.center);
      camera.position.copy(home).normalize().multiplyScalar(distance).add(bounds.center);
      controls.maxDistance = Math.max(37, distance * 1.6);
      scene.fog.density = Math.min(0.026, 0.65 / distance);
      camera.far = Math.max(110, distance * 3);
      camera.updateProjectionMatrix();
    }
    controls.update();
  }

  function setSelected(id) {
    selectedId = id == null ? null : String(id);
    for (const [key, record] of records) {
      const selected = key === selectedId;
      record.selection.visible = selected;
      record.label.classList.toggle('is-selected', selected);
      record.label.setAttribute('aria-pressed', String(selected));
      record.glow.material.opacity = selected ? 0.9 : record.device.kind === 'gateway' ? 0.8 : 0.48;
    }
  }

  function applyFilter() {
    for (const [id, record] of records) {
      record.group.visible = !filterIds || filterIds.has(id);
      record.label.hidden = !record.group.visible;
    }
    linkGroup.children.forEach(line => {
      line.visible = !filterIds || (filterIds.has(line.userData.source) && filterIds.has(line.userData.target));
    });
  }

  function setFilter(ids) {
    filterIds = ids == null ? null : new Set([...ids].map(String));
    applyFilter();
  }

  function hitTest(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObjects(pickTargets, false).find(hit => hit.object.parent.visible);
  }

  function onPointerDown(event) { pointerStart = { x: event.clientX, y: event.clientY }; }
  function onPointerUp(event) {
    if (!pointerStart || Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 7) return;
    pointerStart = null;
    const hit = hitTest(event);
    if (hit) onSelect(hit.object.userData.deviceId);
  }
  function onPointerMove(event) { renderer.domElement.style.cursor = hitTest(event) ? 'pointer' : 'grab'; }
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('pointermove', onPointerMove);

  function resize() {
    if (destroyed) return;
    width = Math.max(container.clientWidth, 1);
    height = Math.max(container.clientHeight, 1);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    frameScene();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  function render(time) {
    if (destroyed || document.hidden || time - lastTime < 1000 / 45) return;
    const delta = Math.min((time - lastTime) / 1000, 0.1);
    lastTime = time;
    const elapsed = clock.getElapsedTime();
    controls.update(delta);
    if (!reducedMotion.matches) {
      records.forEach(record => {
        record.core.rotation.y = elapsed * 0.08 + record.phase;
        if (record.device.kind === 'gateway') record.band.rotation.y = elapsed * 0.04;
      });
    }
    renderer.render(scene, camera);
    const used = [];
    const sorted = [...records.entries()].sort(([a, ar], [b, br]) => {
      if (a === selectedId) return -1;
      if (b === selectedId) return 1;
      const rank = { gateway: 0, self: 1, device: 2 };
      return (rank[ar.device.kind] ?? 2) - (rank[br.device.kind] ?? 2);
    });
    for (const [id, record] of sorted) {
      if (!record.group.visible) { record.label.hidden = true; continue; }
      projection.copy(record.group.position);
      projection.y += record.radius + 0.3;
      projection.project(camera);
      const x = (projection.x * 0.5 + 0.5) * width;
      const y = (-projection.y * 0.5 + 0.5) * height;
      const inFrame = projection.z > -1 && projection.z < 1 && x > 52 && x < width - 52 && y > 40 && y < height - 30;
      const overlaps = used.some(box => Math.abs(box.x - x) < 125 && Math.abs(box.y - y) < 49);
      const visible = inFrame && (!overlaps || id === selectedId || record.device.kind === 'gateway');
      record.label.hidden = !visible;
      if (!visible) continue;
      record.label.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      record.label.style.zIndex = id === selectedId ? '3' : record.device.kind === 'gateway' ? '2' : '1';
      used.push({ x, y });
    }
  }
  renderer.setAnimationLoop(render);

  function onMotionChange() { if (reducedMotion.matches) controls.autoRotate = false; }
  reducedMotion.addEventListener('change', onMotionChange);

  return {
    setDevices, setSelected, setFilter,
    setAutoRotate(value) { controls.autoRotate = Boolean(value); },
    reset: frameScene,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      renderer.setAnimationLoop(null);
      observer.disconnect();
      reducedMotion.removeEventListener('change', onMotionChange);
      controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      disposeGroup(nodeGroup);
      disposeGroup(linkGroup);
      disposeGroup(atmosphere);
      glowTexture.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      labels.replaceChildren();
      records.clear();
      pickTargets = [];
    }
  };
}
