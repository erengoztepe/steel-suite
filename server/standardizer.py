import sys
import json
import argparse
import os
import glob
import xml.etree.ElementTree as ET

try:
    from ideastatica_connection_api.connection_api_service_attacher import ConnectionApiServiceAttacher
except ImportError:
    print(json.dumps({"error": "Missing SDK. Please run: pip install ideastatica-connection-api==26.0.*"}))
    sys.exit(1)

def strip_namespaces(xml_string):
    """
    Remove the namespace prefix from all tags in the XML string.
    This makes querying much simpler.
    """
    try:
        # Some IdeaStatiCa exports have utf-16 in the declaration but are actually utf-8.
        # We strip out the XML declaration completely to avoid encoding mismatch errors in ET.
        if xml_string.startswith("<?xml"):
            end_idx = xml_string.find("?>")
            if end_idx != -1:
                xml_string = xml_string[end_idx+2:].strip()
        
        root = ET.fromstring(xml_string)
        for elem in root.iter():
            if '}' in elem.tag:
                elem.tag = elem.tag.split('}', 1)[1]
        return root
    except Exception as e:
        print(f"XML Parse error: {e}", file=sys.stderr)
        return None

def process_directory(base_url, directory):
    results = []
    
    if not os.path.isdir(directory):
        return {"error": f"Directory not found: {directory}"}

    ideacon_files = glob.glob(os.path.join(directory, "*.ideaCon"))
    
    if not ideacon_files:
        return {"error": "No .ideaCon files found in the directory."}

    try:
        attacher = ConnectionApiServiceAttacher(base_url)
    except Exception as e:
        return {"error": f"Could not connect to API at {base_url}. Error: {e}"}

    try:
        with attacher.create_api_client() as api_client:
            
            for file_path in ideacon_files:
                file_name = os.path.basename(file_path)
                print(f"Processing: {file_name}", file=sys.stderr)
                
                try:
                    # 1. Open Project
                    project_id = api_client.project.open_project_from_filepath(file_path)
                    
                    # 2. Get Connections
                    connections = api_client.connection.get_connections(project_id)
                    
                    # 3. Process Each Connection
                    for conn in connections:
                        conn_name = conn.name or f"Conn_{conn.id}"
                        
                        # 4. Export IOM Raw Bytes
                        # We must use the non-JSON parser to get raw XML bytes
                        raw_response = api_client.project.export_iom_without_preload_content(project_id, conn.id)
                        
                        try:
                            # Try to decode safely (UTF-8 sig or fallback to UTF-16)
                            xml_str = raw_response.data.decode('utf-8-sig')
                        except UnicodeDecodeError:
                            xml_str = raw_response.data.decode('utf-16')
                            
                        root = strip_namespaces(xml_str)
                        if root is None:
                            continue
                            
                        # --- 5. Extract Bolt Assemblies Dictionary ---
                        # OpenModel/BoltAssembly/BoltAssembly -> Id, Name, Diameter
                        bolt_dict = {}
                        for ba in root.findall('.//BoltAssembly'):
                            b_id = ba.findtext('Id')
                            b_name = ba.findtext('Name')
                            b_dia_str = ba.findtext('Diameter')
                            if b_id and b_dia_str:
                                dia_m = float(b_dia_str)
                                grade = b_name.split()[-1] if b_name else "Unknown"
                                label = f"M{round(dia_m * 1000)} {grade}"
                                bolt_dict[b_id] = label
                        
                        # --- 6. Parse Plates ---
                        for plate in root.findall('.//Connections/ConnectionData/Plates/PlateData'):
                            is_neg = plate.findtext('IsNegativeObject')
                            if is_neg and is_neg.lower() == 'true':
                                continue # Skip negative plates (operations)
                                
                            thick_str = plate.findtext('Thickness')
                            if thick_str:
                                thickness_mm = round(float(thick_str) * 1000, 1)
                                results.append({
                                    "file": file_name,
                                    "connection": conn_name,
                                    "category": "Plate",
                                    "size_label": f"{thickness_mm} mm"
                                })

                        # --- 7. Parse Welds ---
                        for weld in root.findall('.//Connections/ConnectionData/Welds/WeldData'):
                            thick_str = weld.findtext('Thickness')
                            if thick_str:
                                thickness_mm = round(float(thick_str) * 1000, 1)
                                # Exclude tiny 0.0 welds if they are placeholders
                                if thickness_mm > 0:
                                    results.append({
                                        "file": file_name,
                                        "connection": conn_name,
                                        "category": "Weld",
                                        "size_label": f"a{thickness_mm}"
                                    })
                                
                        # --- 8. Parse Bolts (BoltGrids) ---
                        for bg in root.findall('.//Connections/ConnectionData/BoltGrids/BoltGrid'):
                            ba_id = bg.findtext('.//BoltAssembly/Id')
                            if ba_id and ba_id in bolt_dict:
                                results.append({
                                    "file": file_name,
                                    "connection": conn_name,
                                    "category": "Bolt",
                                    "size_label": bolt_dict[ba_id]
                                })
                                
                except Exception as e:
                    print(f"Error processing {file_name}: {e}", file=sys.stderr)
                
                finally:
                    # Clean up: close the project to release lock
                    try:
                        api_client.project.close_project(project_id)
                    except:
                        pass
                        
            return {"data": results}

    except Exception as e:
        print(f"API Client Error: {e}", file=sys.stderr)
        return {"error": f"API Error: {e}"}

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="IDEA StatiCa Standardization Scanner")
    parser.add_argument("--base-url", type=str, default="http://localhost:5000", help="API Base URL")
    parser.add_argument("--dir", type=str, required=True, help="Directory containing .ideaCon files")
    
    args = parser.parse_args()
    
    result = process_directory(args.base_url, args.dir)
    print(json.dumps(result))
