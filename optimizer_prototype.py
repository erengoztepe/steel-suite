import sys
import json
import time

try:
    from ideastatica_connection_api.connection_api_service_attacher import ConnectionApiServiceAttacher
    from ideastatica_connection_api import IdeaParameterUpdate
except ImportError:
    print("ERROR: Missing SDK. Please run: pip install ideastatica-connection-api==26.0.*")
    exit(1)


class ConnectionApiError(Exception):
    pass


def parse_cost(cost_obj):
    """
    Production cost field is UNDOCUMENTED.
    Dynamically discover the total cost from the ConProductionCost object.
    """
    if cost_obj is None:
        return None

    data = cost_obj.to_dict() if hasattr(cost_obj, 'to_dict') else vars(cost_obj)
    
    # Strip leading underscores from dict keys
    clean_data = {k.lstrip('_'): v for k, v in data.items()}

    # Look for a field containing "total", else "cost", else "price"
    for keyword in ["total", "cost", "price"]:
        for k, v in clean_data.items():
            if keyword in k.lower() and isinstance(v, (int, float)):
                return v
    
    # Proxy: sum all numeric fields
    numeric_sum = sum(v for v in clean_data.values() if isinstance(v, (int, float)))
    if numeric_sum > 0:
        return numeric_sum
        
    return 0.0


def parse_check_status(result_summary):
    """
    PASS semantics: The connection passes only if EVERY non-skipped check passes.
    No checks -> FAIL.
    """
    if not result_summary:
        return False, None
    
    all_passed = True
    max_util = 0.0
    valid_checks = 0

    for check in result_summary:
        if getattr(check, 'skipped', False):
            continue
        
        valid_checks += 1
        
        status = getattr(check, 'check_status', False)
        # Handle boolean or string cases
        if isinstance(status, str):
            status = status.lower() in ["ok", "pass", "passed", "true"]
        
        if not status:
            all_passed = False
        
        val = getattr(check, 'check_value', 0.0)
        if val is not None and val > max_util:
            max_util = val

    if valid_checks == 0:
        return False, None
        
    return all_passed, max_util


def run_sweep(base_url, project_path, parameter_key, range_list, sweep_direction):
    """
    Runs a parameter sweep.
    sweep_direction: 'INCREASING', 'DECREASING', or 'UNORDERED'
    """
    history = []
    
    try:
        attacher = ConnectionApiServiceAttacher(base_url)
    except Exception as e:
        raise ConnectionApiError(f"Could not connect to API at {base_url}. Is IdeaStatiCa.ConnectionRestApi.exe running? Error: {e}")

    try:
        with attacher.create_api_client() as api_client:
            print(f"Opening project: {project_path}")
            api_client.project.open_project_from_filepath(project_path)
            project_id = api_client.project.active_project_id
            
            # Get the first connection
            conns = api_client.connection.get_connections(project_id)
            if not conns:
                raise ConnectionApiError("No connections found in the project.")
            conn_id = conns[0].id
            
            print(f"Optimizing connection {conn_id} for parameter '{parameter_key}'...")
            
            # Check available parameters
            params = api_client.parameter.get_parameters(project_id, conn_id)
            param_keys = [p.key for p in params] if params else []
            print(f"Available parameters in this connection: {param_keys}")
            
            if parameter_key not in param_keys:
                raise ConnectionApiError(f"Parameter '{parameter_key}' not found. Available parameters are: {param_keys}")
            
            best_passing_val = None
            best_cost = float('inf')

            for iteration, val in enumerate(range_list, 1):
                print(f"\n[Iter {iteration}] Testing {parameter_key} = {val}...")
                
                # 1. Update Parameter
                expression_val = "true" if val is True else ("false" if val is False else str(val))
                update_req = IdeaParameterUpdate(key=parameter_key, expression=expression_val)
                api_client.parameter.update(project_id, conn_id, [update_req])
                
                # 2. Calculate
                calc_results = api_client.calculation.calculate(project_id, [conn_id])
                if not calc_results or not calc_results[0].result_summary:
                    print("  -> Calculation failed or returned no results.")
                    status = False
                    max_util = None
                else:
                    status, max_util = parse_check_status(calc_results[0].result_summary)
                
                # 3. Get Cost
                cost_obj = api_client.connection.get_production_cost(project_id, conn_id)
                cost = parse_cost(cost_obj)
                
                # Log history
                history.append({
                    "iteration": iteration,
                    "value": val,
                    "status": "PASS" if status else "FAIL",
                    "max_utilization": max_util,
                    "cost": cost
                })
                
                print(f"  -> Result: {'PASS' if status else 'FAIL'} | Max Util: {max_util}% | Cost: {cost}")

                # 4. Sweep Boundary Logic
                if status:
                    if cost is not None and cost < best_cost:
                        best_cost = cost
                        best_passing_val = val
                    elif best_passing_val is None:
                        best_passing_val = val

                if sweep_direction == 'DECREASING':
                    # Walk high->low, stop on FIRST FAIL
                    if not status:
                        print(f"  -> Stopping sweep: hit boundary (first FAIL in DECREASING mode).")
                        break
                elif sweep_direction == 'INCREASING':
                    # Walk low->high, stop at FIRST PASS
                    if status:
                        print(f"  -> Stopping sweep: hit boundary (first PASS in INCREASING mode).")
                        break
                        
            # Apply best passing value before exiting so the state is ready for the next sweep or save
            if best_passing_val is not None:
                print(f"\nApplying best passing value: {best_passing_val} (Cost: {best_cost})")
                expr = "true" if best_passing_val is True else ("false" if best_passing_val is False else str(best_passing_val))
                api_client.parameter.update(project_id, conn_id, [IdeaParameterUpdate(key=parameter_key, expression=expr)])
                api_client.calculation.calculate(project_id, [conn_id])
            else:
                print("\nWARNING: No passing value found in this sweep range!")

            return history

    except Exception as e:
        raise ConnectionApiError(f"API Error during sweep: {e}")


if __name__ == "__main__":
    print("=" * 60)
    print(" IDEA StatiCa - Parameter Optimization Sweep Prototype")
    print("=" * 60)
    
    # YOU CAN CHANGE THESE HARDCODED VALUES FOR LOCAL TESTING:
    BASE_URL = "http://localhost:5000"
    TEST_PROJECT_PATH = sys.argv[1] if len(sys.argv) > 1 else "BasePlate.ideaCon"  # any .ideaCon project
    TARGET_PARAMETER = "Plate_Thickness~1" # e.g. plate thickness
    SWEEP_MODE = "DECREASING"
    
    TEST_RANGE = [20.0, 15.0, 12.0, 10.0, 8.0, 5.0]

    print(f"\nConfiguration:")
    print(f"- URL: {BASE_URL}")
    print(f"- Project: {TEST_PROJECT_PATH}")
    print(f"- Parameter: {TARGET_PARAMETER}")
    print(f"- Mode: {SWEEP_MODE}")
    print(f"- Range: {TEST_RANGE}\n")

    try:
        hist = run_sweep(
            base_url=BASE_URL,
            project_path=TEST_PROJECT_PATH,
            parameter_key=TARGET_PARAMETER,
            range_list=TEST_RANGE,
            sweep_direction=SWEEP_MODE
        )
        print("\nSweep Complete! History:")
        print(json.dumps(hist, indent=2))
    except ConnectionApiError as e:
        print(f"\nFailed: {e}")
