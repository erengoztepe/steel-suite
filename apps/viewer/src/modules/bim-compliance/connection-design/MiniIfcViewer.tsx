import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Components, IfcLoader, FragmentsManager } from "@thatopen/components";

interface MiniIfcViewerProps {
  buffer: ArrayBuffer | null;
}

export function MiniIfcViewer({ buffer }: MiniIfcViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const componentsRef = useRef<Components | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [debugLog, setDebugLog] = useState<string>("Initializing...");

  useEffect(() => {
    if (!containerRef.current || !buffer || buffer.byteLength === 0) return;

    let disposed = false;
    
    const init = async () => {
      try {
        setDebugLog("Creating components...");
        const components = new Components();
        componentsRef.current = components;

        components.init();

        setDebugLog("Setting up WebGL...");
        // Let's use simple Three.js for a more reliable lightweight viewer
        const width = containerRef.current!.clientWidth || 200;
        const height = containerRef.current!.clientHeight || 200;

        const threeScene = new THREE.Scene();
        threeScene.background = new THREE.Color(0xf0f0f0);
        
        const threeCamera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100000);
        threeCamera.position.set(2, 2, 2);
        threeCamera.lookAt(0, 0, 0);

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(width, height);
        // Clear only previous canvases
        const canvases = containerRef.current!.getElementsByTagName('canvas');
        while (canvases.length > 0) canvases[0].remove();
        containerRef.current!.appendChild(renderer.domElement);

        const light1 = new THREE.DirectionalLight(0xffffff, 1);
        light1.position.set(10, 10, 10);
        threeScene.add(light1);
        threeScene.add(new THREE.AmbientLight(0x404040, 1.5));

        setDebugLog("Setting up IfcLoader...");
        // Let's load the IFC using thatopen
        const ifcLoader = components.get(IfcLoader);
        await ifcLoader.setup({ autoSetWasm: false, wasm: { path: "/wasm/web-ifc/", absolute: true } });
        
        setDebugLog("Init FragmentsManager...");
        const fragmentsManager = components.get(FragmentsManager);
        await fragmentsManager.init("/worker.mjs");

        let finalBuffer = buffer;
        if (buffer.byteLength === 1) {
          setDebugLog("Fetching mock model...");
          // It's a mock 1-byte buffer indicating API is down
          const res = await fetch("/models/mock_connection.ifc");
          finalBuffer = await res.arrayBuffer();
        }

        setDebugLog("Loading IFC buffer...");
        const model = await ifcLoader.load(new Uint8Array(finalBuffer), true, "mini_model.ifc");

        setDebugLog("Adding to scene...");
        // Add to three.js scene manually
        (model as any).items?.forEach((fragment: any) => {
          if (fragment.mesh) {
            // Recenter it at origin so we can see it
            fragment.mesh.position.set(0, 0, 0);
            fragment.mesh.material = new THREE.MeshStandardMaterial({
              color: 0x0055ff,
              roughness: 0.5,
              metalness: 0.5,
            });
            threeScene.add(fragment.mesh);
          }
        });

        setDebugLog("Model loaded!");

        // Frame to fit
        const box = new THREE.Box3().setFromObject(threeScene);
        if (!box.isEmpty()) {
          const center = box.getCenter(new THREE.Vector3());
          const size = box.getSize(new THREE.Vector3());
          const maxDim = Math.max(size.x, size.y, size.z);
          const fov = threeCamera.fov * (Math.PI / 180);
          let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
          cameraZ *= 1.5;
          threeCamera.position.set(center.x, center.y + cameraZ * 0.5, center.z + cameraZ);
          threeCamera.lookAt(center);
        }

        const animate = () => {
          if (disposed) return;
          requestAnimationFrame(animate);
          threeScene.rotation.y += 0.01; // Auto rotate
          renderer.render(threeScene, threeCamera);
        };
        animate();

      } catch (err: any) {
        console.error("Mini viewer failed:", err);
        if (!disposed) setError(err.message);
      }
    };

    init();

    return () => {
      disposed = true;
      if (componentsRef.current) {
        componentsRef.current.dispose();
      }
    };
  }, [buffer]);

  if (!buffer || buffer.byteLength === 0) return null;

  return (
    <div className="mt-4 flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-gray-800">Test IFC Viewer (Gelen Model)</h3>
      {error ? (
        <div className="text-red-500 text-xs">{error}</div>
      ) : (
        <div ref={containerRef} className="w-full h-64 border rounded-md shadow-inner bg-gray-50 overflow-hidden relative">
          <div className="absolute top-2 left-2 text-xs text-blue-500 font-mono bg-white/80 px-2 py-1 rounded shadow z-10 pointer-events-none">
            {debugLog}
          </div>
        </div>
      )}
    </div>
  );
}
