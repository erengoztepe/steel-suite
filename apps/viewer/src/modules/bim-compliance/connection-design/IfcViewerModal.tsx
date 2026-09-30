import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Components, IfcLoader, FragmentsManager } from "@thatopen/components";
import { Close } from "@/icons";

export interface IfcViewerModalProps {
  buffer: ArrayBuffer | null;
  onClose: () => void;
}

export function IfcViewerModal({ buffer, onClose }: IfcViewerModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [debugLog, setDebugLog] = useState<string>("Initializing 3D Viewer...");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted || !containerRef.current || !buffer || buffer.byteLength === 0) return;

    let disposed = false;
    let reqId: number;
    const components = new Components();

    const init = async () => {
      try {
        setDebugLog("Creating components...");
        components.init();

        setDebugLog("Setting up WebGL...");
        const width = containerRef.current!.clientWidth;
        const height = containerRef.current!.clientHeight;

        const threeScene = new THREE.Scene();
        threeScene.background = new THREE.Color(0x1a1a1a);
        
        const threeCamera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100000);
        threeCamera.position.set(2, 2, 2);
        threeCamera.lookAt(0, 0, 0);

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        renderer.setSize(width, height);
        
        const canvases = containerRef.current!.getElementsByTagName('canvas');
        while (canvases.length > 0) canvases[0].remove();
        containerRef.current!.appendChild(renderer.domElement);

        const controls = new OrbitControls(threeCamera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;

        const light1 = new THREE.DirectionalLight(0xffffff, 1);
        light1.position.set(10, 10, 10);
        threeScene.add(light1);
        const light2 = new THREE.DirectionalLight(0xffffff, 0.8);
        light2.position.set(-10, 10, -10);
        threeScene.add(light2);
        threeScene.add(new THREE.AmbientLight(0x404040, 1.5));

        setDebugLog("Setting up IfcLoader...");
        const ifcLoader = components.get(IfcLoader);
        await ifcLoader.setup({ autoSetWasm: false, wasm: { path: "/wasm/web-ifc/", absolute: true } });
        
        setDebugLog("Init FragmentsManager...");
        const fragmentsManager = components.get(FragmentsManager);
        await fragmentsManager.init("/worker.mjs");

        let finalBuffer = buffer;
        if (buffer.byteLength === 1) {
          setDebugLog("Fetching mock model...");
          const res = await fetch("/models/mock_connection.ifc");
          finalBuffer = await res.arrayBuffer();
        }

        setDebugLog("Loading IFC buffer...");
        const model = await ifcLoader.load(new Uint8Array(finalBuffer), true, "modal_model.ifc");

        setDebugLog("Adding to scene...");
        (model as any).items?.forEach((fragment: any) => {
          if (fragment.mesh) {
            fragment.mesh.position.set(0, 0, 0);
            
            fragment.mesh.material = new THREE.MeshStandardMaterial({
              color: 0x9099a2,
              roughness: 0.4,
              metalness: 0.6,
              side: THREE.DoubleSide
            });
            
            const edges = new THREE.EdgesGeometry(fragment.mesh.geometry);
            const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 2 }));
            fragment.mesh.add(line);

            threeScene.add(fragment.mesh);
          }
        });

        setDebugLog(""); 

        const box = new THREE.Box3().setFromObject(threeScene);
        if (!box.isEmpty()) {
          const center = box.getCenter(new THREE.Vector3());
          const size = box.getSize(new THREE.Vector3());
          const maxDim = Math.max(size.x, size.y, size.z);
          const fov = threeCamera.fov * (Math.PI / 180);
          let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
          cameraZ *= 1.5; 
          
          threeCamera.position.set(center.x + cameraZ * 0.5, center.y + cameraZ * 0.5, center.z + cameraZ);
          threeCamera.lookAt(center);
          controls.target.copy(center);
        }

        const animate = () => {
          if (disposed) return;
          reqId = requestAnimationFrame(animate);
          controls.update();
          renderer.render(threeScene, threeCamera);
        };
        animate();

        const handleResize = () => {
          if (!containerRef.current) return;
          const w = containerRef.current.clientWidth;
          const h = containerRef.current.clientHeight;
          renderer.setSize(w, h);
          threeCamera.aspect = w / h;
          threeCamera.updateProjectionMatrix();
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);

      } catch (err: any) {
        if (!disposed) setDebugLog("Error: " + err.message);
      }
    };
    init();

    return () => {
      disposed = true;
      cancelAnimationFrame(reqId);
      components.dispose();
    };
  }, [buffer, mounted]);

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/80 backdrop-blur-sm p-8 animate-[ve-fade-in_0.2s_ease-out]">
      <div className="relative w-full max-w-6xl h-full max-h-[85vh] bg-bg-primary rounded-xl overflow-hidden shadow-2xl flex flex-col border border-border-primary/50">
        <div className="flex justify-between items-center px-4 py-3 bg-bg-secondary border-b border-border-primary">
          <h2 className="text-lg font-semibold text-text-primary">3D Connection Viewer (IFC)</h2>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-bg-tertiary rounded text-text-secondary hover:text-text-primary transition-colors"
            title="Close"
          >
            <Close className="w-5 h-5" />
          </button>
        </div>
        
        <div className="relative flex-1 bg-[#1a1a1a]">
          {debugLog && (
            <div className="absolute inset-0 flex items-center justify-center text-brand-secondary font-medium animate-pulse z-10 pointer-events-none">
              {debugLog}
            </div>
          )}
          <div ref={containerRef} className="absolute inset-0" />
        </div>
        
        <div className="px-4 py-3 bg-bg-secondary border-t border-border-primary flex justify-between items-center text-xs text-text-secondary">
          <span>Mouse Left: Rotate | Right: Pan | Scroll: Zoom</span>
          <span>Powered by IDEA StatiCa & Web-IFC</span>
        </div>
      </div>
    </div>,
    document.body
  );
}
